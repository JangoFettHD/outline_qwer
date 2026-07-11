import { addSeconds, isBefore } from "date-fns";
import Logger from "@server/logging/Logger";
import { AuthenticationProvider, UserAuthentication } from "@server/models";
import type { User } from "@server/models";
import fetch from "@server/utils/fetch";
import { MutexLock } from "@server/utils/MutexLock";
import config from "../plugin.json";
import env from "./env";

const TOKEN_URL = "https://oauth.bitrix.info/oauth/token/";

/** HTTP timeout for every Bitrix24 request (token + REST). */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Bitrix24 error codes that mean the stored token is no longer usable and the
 * user must re-authorise. We surface these distinctly so callers can prompt a
 * reconnect instead of silently returning empty data.
 */
const REAUTH_ERROR_CODES = new Set([
  "expired_token",
  "invalid_token",
  "NO_AUTH_FOUND",
  "INVALID_TOKEN",
  "insufficient_scope",
]);

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  /** Per-portal REST base, e.g. `https://qwer.bitrix24.ru/rest/`. */
  client_endpoint?: string;
}

interface RestErrorResponse {
  error?: string;
  error_description?: string;
}

/**
 * Result of a successful Bitrix24 REST call. `result` is the payload Bitrix24
 * returns under its top-level `result` key — shape varies by method.
 */
export interface RestSuccess<T> {
  result: T;
}

/**
 * A typed Bitrix24 REST failure. Carries the raw `error` code and
 * `error_description` so callers (e.g. createTask) can show the real reason
 * to the user rather than a generic message.
 */
export class Bitrix24Error extends Error {
  public readonly code: string;
  public readonly description?: string;
  /** True when the failure means the user must reconnect Bitrix24. */
  public readonly reauthRequired: boolean;

  constructor(code: string, description?: string) {
    super(description || code);
    this.name = "Bitrix24Error";
    this.code = code;
    this.description = description;
    this.reauthRequired = REAUTH_ERROR_CODES.has(code);
  }
}

/**
 * Refresh an expired Bitrix24 OAuth token. Bitrix24's token endpoint is shared
 * for all cloud portals — `oauth.bitrix.info` — and returns the new
 * access/refresh tokens for the same portal.
 *
 * @param refreshToken refresh token previously issued for this user.
 * @returns parsed token response.
 * @throws {Bitrix24Error} when the token endpoint reports an error (e.g.
 *   invalid_grant when the refresh token itself has expired).
 * @throws {Error} on transport/parse failures (caller decides whether the
 *   still-valid access token can be reused).
 */
async function rotateToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", env.BITRIX24_CLIENT_ID!);
  body.set("client_secret", env.BITRIX24_CLIENT_SECRET!);
  body.set("refresh_token", refreshToken);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    timeout: REQUEST_TIMEOUT_MS,
  });
  const text = await res.text();
  let json: TokenResponse & RestErrorResponse;
  try {
    json = JSON.parse(text) as TokenResponse & RestErrorResponse;
  } catch (_err) {
    throw new Error(
      `Bitrix24 token refresh returned non-JSON (HTTP ${res.status}): ${text.slice(0, 160)}`
    );
  }
  if (json.error) {
    throw new Bitrix24Error(json.error, json.error_description);
  }
  return json;
}

/**
 * Load the Bitrix24 UserAuthentication row for the given user, or `null` if
 * they have never signed in via Bitrix24.
 *
 * @param user user whose token row we need.
 * @returns the row, or null.
 */
async function loadAuth(user: User): Promise<UserAuthentication | null> {
  const provider = await AuthenticationProvider.findOne({
    where: { name: config.id, teamId: user.teamId },
  });
  if (!provider) {
    return null;
  }
  return UserAuthentication.findOne({
    where: { userId: user.id, authenticationProviderId: provider.id },
    order: [["createdAt", "DESC"]],
  });
}

/**
 * Ensure the auth row holds a currently-valid access token, refreshing it if
 * it is within five minutes of expiry. The refresh is serialised across
 * processes with a Redis mutex so the 9-way search fan-out (or several embeds
 * on one page) performs exactly one token rotation instead of racing — which
 * would otherwise clobber Bitrix24's single-use rotated refresh token.
 *
 * @param auth the UserAuthentication row (mutated + persisted on refresh).
 * @param force when true, refresh even if the token looks valid (used after a
 *   Bitrix24 expired_token error, where the portal revoked the token early).
 * @throws {Bitrix24Error} with reauthRequired when the refresh token itself is
 *   dead (invalid_grant); the row's refreshToken/expiresAt are cleared so we
 *   stop retrying a doomed refresh on every call.
 */
async function ensureFreshToken(
  auth: UserAuthentication,
  force = false
): Promise<void> {
  const withinWindow = () =>
    !!auth.expiresAt &&
    isBefore(new Date(auth.expiresAt), addSeconds(Date.now(), 5 * 60));

  // Follow the core model's stance: a null expiresAt means the provider never
  // returned an expiry, so we cannot proactively refresh — rely on the
  // force-refresh triggered by an expired_token error instead. This avoids a
  // refresh on literally every call (which would guarantee the rotation race).
  if (!force && !withinWindow()) {
    return;
  }
  if (!auth.refreshToken) {
    return;
  }

  await MutexLock.using(
    `bitrix24:refresh:${auth.id}`,
    MutexLock.defaultLockTimeout,
    async () => {
      // Re-read inside the lock: a concurrent caller may have already
      // refreshed while we waited to acquire it.
      await auth.reload();
      if (!force && !withinWindow()) {
        return;
      }
      if (!auth.refreshToken) {
        return;
      }
      try {
        const next = await rotateToken(auth.refreshToken);
        auth.accessToken = next.access_token;
        if (next.refresh_token) {
          auth.refreshToken = next.refresh_token;
        }
        auth.expiresAt = addSeconds(Date.now(), next.expires_in);
        await auth.save();
        Logger.info("authentication", "Refreshed Bitrix24 access token", {
          userId: auth.userId,
        });
      } catch (err) {
        if (err instanceof Bitrix24Error && err.reauthRequired) {
          throw err;
        }
        // invalid_grant → the refresh token is permanently dead. Clear it so
        // subsequent calls short-circuit without hammering oauth.bitrix.info,
        // and signal the caller to prompt a reconnect.
        if (
          err instanceof Bitrix24Error &&
          err.code === "invalid_grant"
        ) {
          auth.refreshToken = "";
          auth.expiresAt = null;
          await auth.save();
          throw new Bitrix24Error("expired_token", "Bitrix24 session expired");
        }
        // Transient failure (network/parse): if the current access token is
        // still valid for a few more minutes, keep using it rather than
        // blacking out all Bitrix24 features.
        if (auth.expiresAt && isBefore(new Date(), new Date(auth.expiresAt))) {
          Logger.warn(
            `Bitrix24 token refresh failed transiently for user ${auth.userId}, reusing valid token: ${(err as Error).message}`
          );
          return;
        }
        throw err;
      }
    }
  );
}

/**
 * Get a live access token and REST base URL for the user, refreshing if
 * needed.
 *
 * @param user user whose token we need.
 * @returns credentials, or `null` when the user has no usable Bitrix24 link
 *   (never connected, or refresh token permanently dead).
 * @throws never — reauth-required is folded into `null`; callers that need to
 *   distinguish should catch Bitrix24Error from callRestOrThrow instead.
 */
export async function getAccessToken(
  user: User
): Promise<{ accessToken: string; restBase: string; auth: UserAuthentication } | null> {
  const auth = await loadAuth(user);
  if (!auth) {
    return null;
  }
  try {
    await ensureFreshToken(auth);
  } catch (err) {
    if (err instanceof Bitrix24Error && err.reauthRequired) {
      return null;
    }
    Logger.warn(
      `Bitrix24 getAccessToken failed for user ${user.id}: ${(err as Error).message}`
    );
    return null;
  }
  const restBase = env.BITRIX24_PORTAL_URL!.replace(/\/$/, "") + "/rest";
  return { accessToken: auth.accessToken, restBase, auth };
}

/**
 * Serialise params into an `application/x-www-form-urlencoded` body for
 * Bitrix24. Array values become repeated `key[]` entries; a key that already
 * ends with `[]` is not double-bracketed. Nested keys like `fields[TITLE]`
 * and `FILTER[ID]` are passed through verbatim.
 *
 * @param params request params.
 * @param accessToken OAuth token, added as the `auth` field.
 * @returns a URLSearchParams body.
 */
function buildBody(
  params: Record<string, string | number | Array<string | number>>,
  accessToken: string
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("auth", accessToken);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      const key = k.endsWith("[]") ? k : `${k}[]`;
      for (const item of v) {
        body.append(key, String(item));
      }
    } else {
      body.set(k, String(v));
    }
  }
  return body;
}

/**
 * Low-level Bitrix24 REST POST. Sends params + auth in the form body (not the
 * query string) so long payloads (task descriptions) don't overflow URL
 * limits and the token never lands in access logs.
 *
 * @param restBase per-portal REST base URL.
 * @param method REST method, e.g. `tasks.task.get`.
 * @param params request params.
 * @param accessToken OAuth token.
 * @returns the parsed JSON body (either `{ result }` or `{ error }`).
 * @throws {Error} on transport/parse failure.
 */
async function post<T>(
  restBase: string,
  method: string,
  params: Record<string, string | number | Array<string | number>>,
  accessToken: string
): Promise<(RestSuccess<T> & RestErrorResponse) | RestErrorResponse> {
  const res = await fetch(`${restBase}/${method}.json`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: buildBody(params, accessToken),
    timeout: REQUEST_TIMEOUT_MS,
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as
      | (RestSuccess<T> & RestErrorResponse)
      | RestErrorResponse;
  } catch (_err) {
    throw new Error(
      `Bitrix24 ${method} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 160)}`
    );
  }
}

/**
 * Perform a Bitrix24 REST call on behalf of the user, returning the unwrapped
 * `result` or `null` on any expected failure. Used by unfurl/search read
 * paths where a quiet "no data" is preferable to an exception.
 *
 * If Bitrix24 reports the token expired, forces a single refresh + retry
 * before giving up, so a token the portal revoked early self-heals.
 *
 * @param user actor whose OAuth token authorises the call.
 * @param method Bitrix24 REST method.
 * @param params request params.
 * @returns the unwrapped `result` field, or `null`.
 */
export async function callRest<T>(
  user: User,
  method: string,
  params: Record<string, string | number | Array<string | number>> = {}
): Promise<T | null> {
  const creds = await getAccessToken(user);
  if (!creds) {
    return null;
  }

  try {
    let json = await post<T>(creds.restBase, method, params, creds.accessToken);

    // Token revoked early by the portal — force a refresh and retry once.
    if (json.error && REAUTH_ERROR_CODES.has(json.error)) {
      try {
        await ensureFreshToken(creds.auth, true);
        json = await post<T>(
          creds.restBase,
          method,
          params,
          creds.auth.accessToken
        );
      } catch (refreshErr) {
        Logger.warn(
          `Bitrix24 ${method} reauth failed: ${(refreshErr as Error).message}`
        );
        return null;
      }
    }

    if (json.error) {
      Logger.debug(
        "plugins",
        `Bitrix24 REST ${method} returned error: ${json.error}`
      );
      return null;
    }
    return (json as RestSuccess<T>).result;
  } catch (err) {
    Logger.warn(`Bitrix24 REST ${method} failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Like {@link callRest} but throws a {@link Bitrix24Error} carrying the real
 * error code/description instead of collapsing to null. Used for mutations
 * (task creation) so the endpoint can report the actual reason to the user.
 *
 * @param user actor.
 * @param method REST method.
 * @param params request params.
 * @returns the unwrapped `result`.
 * @throws {Bitrix24Error} when the user has no link (code `no_auth`) or
 *   Bitrix24 reports an error.
 */
export async function callRestOrThrow<T>(
  user: User,
  method: string,
  params: Record<string, string | number | Array<string | number>> = {}
): Promise<T> {
  const creds = await getAccessToken(user);
  if (!creds) {
    throw new Bitrix24Error("no_auth", "Bitrix24 account is not connected");
  }
  let json = await post<T>(creds.restBase, method, params, creds.accessToken);
  if (json.error && REAUTH_ERROR_CODES.has(json.error)) {
    await ensureFreshToken(creds.auth, true);
    json = await post<T>(creds.restBase, method, params, creds.auth.accessToken);
  }
  if (json.error) {
    throw new Bitrix24Error(
      json.error,
      (json as RestErrorResponse).error_description
    );
  }
  return (json as RestSuccess<T>).result;
}

/**
 * Fetch multiple Bitrix24 users by ID in one call. Passes the IDs as an array
 * param (`FILTER[ID][]=…`) so multi-ID lookups (task author + assignee)
 * actually resolve — a comma-joined string matches no user.
 *
 * @param user actor authorising the call.
 * @param userIds array of Bitrix24 user IDs to fetch.
 * @returns map ID → Bitrix24 user record (subset of fields we use).
 */
export async function fetchUsersByIds(
  user: User,
  userIds: number[]
): Promise<Record<string, Bitrix24UserSummary>> {
  const unique = Array.from(new Set(userIds.filter((id) => id > 0)));
  if (unique.length === 0) {
    return {};
  }
  const result = await callRest<Bitrix24UserSummary[]>(user, "user.get", {
    "FILTER[ID]": unique.map(String),
  });
  const map: Record<string, Bitrix24UserSummary> = {};
  for (const u of result ?? []) {
    map[String(u.ID)] = u;
  }
  return map;
}

export interface Bitrix24UserSummary {
  ID: string | number;
  NAME?: string;
  LAST_NAME?: string;
  EMAIL?: string;
  PERSONAL_PHOTO?: string;
  WORK_POSITION?: string;
  LAST_ACTIVITY_DATE?: string;
}

/**
 * Pretty-print a Bitrix24 user record as "First Last".
 *
 * @param u user summary (typically from `user.get`).
 * @returns full name, falling back to email or `User #ID`.
 */
export function formatUserName(u: Bitrix24UserSummary): string {
  const fullName = [u.NAME, u.LAST_NAME].filter(Boolean).join(" ").trim();
  if (fullName) {
    return fullName;
  }
  if (u.EMAIL) {
    return u.EMAIL;
  }
  return `User #${u.ID}`;
}
