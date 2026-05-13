import { addSeconds, isBefore } from "date-fns";
import { Op } from "sequelize";
import Logger from "@server/logging/Logger";
import { AuthenticationProvider, UserAuthentication } from "@server/models";
import type { User } from "@server/models";
import fetch from "@server/utils/fetch";
import config from "../plugin.json";
import env from "./env";

const TOKEN_URL = "https://oauth.bitrix.info/oauth/token/";

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
 * Refresh an expired Bitrix24 OAuth token. Bitrix24's token endpoint is shared
 * for all cloud portals — `oauth.bitrix.info` — and returns the new
 * access/refresh tokens for the same portal.
 *
 * @param refreshToken refresh token previously issued for this user.
 * @returns parsed token response.
 * @throws Error when the token endpoint returns a non-200 status or a
 *   recognisable Bitrix24 error payload (e.g. invalid_grant).
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
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(
      `Bitrix24 token refresh failed: HTTP ${res.status}; ${text.slice(0, 200)}`
    );
  }
  const json = JSON.parse(text) as TokenResponse & RestErrorResponse;
  if (json.error) {
    throw new Error(
      `Bitrix24 token refresh error: ${json.error_description ?? json.error}`
    );
  }
  return json;
}

/**
 * Find the most recent UserAuthentication record for `bitrix24` provider
 * belonging to the given user, refreshing the access token in-place if it
 * is within five minutes of expiry.
 *
 * @param user user whose token we need.
 * @returns the live access token and the per-portal REST base URL, or
 *   `null` if the user has never signed in via Bitrix24 (no token to use).
 * @throws Error when refresh is attempted and fails (caller should treat as
 *   "no access" and skip unfurl rather than surfacing to UI).
 */
export async function getAccessToken(
  user: User
): Promise<{ accessToken: string; restBase: string } | null> {
  const provider = await AuthenticationProvider.findOne({
    where: { name: config.id, teamId: user.teamId },
  });
  if (!provider) {
    return null;
  }

  const auth = await UserAuthentication.findOne({
    where: {
      userId: user.id,
      authenticationProviderId: provider.id,
    },
    order: [["createdAt", "DESC"]],
  });
  if (!auth) {
    return null;
  }

  // Refresh if expiring within 5 minutes. Bitrix24 access tokens live for
  // ~1 hour; refresh tokens are valid for ~30 days from issue and rotate on
  // every refresh (so we have to persist the new one).
  const needsRefresh =
    !auth.expiresAt ||
    isBefore(new Date(auth.expiresAt), addSeconds(Date.now(), 5 * 60));

  if (needsRefresh && auth.refreshToken) {
    try {
      const next = await rotateToken(auth.refreshToken);
      auth.accessToken = next.access_token;
      if (next.refresh_token) {
        auth.refreshToken = next.refresh_token;
      }
      auth.expiresAt = addSeconds(Date.now(), next.expires_in);
      await auth.save();
      Logger.info("authentication", "Refreshed Bitrix24 access token", {
        userId: user.id,
      });
    } catch (err) {
      Logger.warn(
        `Bitrix24 token refresh failed for user ${user.id}: ${
          (err as Error).message
        }`
      );
      return null;
    }
  }

  // The portal URL is configured at the plugin level. For multi-portal
  // installations this would need to be derived from the token response or a
  // per-user setting; for now we serve a single configured portal.
  const restBase = env.BITRIX24_PORTAL_URL!.replace(/\/$/, "") + "/rest";
  return { accessToken: auth.accessToken, restBase };
}

/**
 * Perform a Bitrix24 REST call on behalf of the given user. Returns parsed
 * `result` payload or `null` if the user has no Bitrix24 link or the call
 * failed for an expected reason (access denied, entity not found).
 * Unexpected errors are logged and swallowed — callers run in unfurl/search
 * paths where a quiet "no data" response is preferable to an exception.
 *
 * @param user actor whose OAuth token authorises the call.
 * @param method Bitrix24 REST method, e.g. `tasks.task.get`.
 * @param params query parameters for the method.
 * @returns the unwrapped `result` field, or `null`.
 */
export async function callRest<T>(
  user: User,
  method: string,
  params: Record<string, string | number | string[]> = {}
): Promise<T | null> {
  const creds = await getAccessToken(user);
  if (!creds) {
    return null;
  }
  const url = new URL(`${creds.restBase}/${method}.json`);
  url.searchParams.set("auth", creds.accessToken);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        url.searchParams.append(`${k}[]`, String(item));
      }
    } else {
      url.searchParams.set(k, String(v));
    }
  }

  try {
    const res = await fetch(url.toString(), { method: "GET" });
    const text = await res.text();
    const json = JSON.parse(text) as (RestSuccess<T> & RestErrorResponse) | T;
    if ((json as RestErrorResponse).error) {
      // Common non-fatal errors: ACCESS_DENIED, NOT_FOUND, ERROR_METHOD_NOT_FOUND.
      // We don't surface these — callers degrade gracefully.
      Logger.debug(
        "plugins",
        `Bitrix24 REST ${method} returned error: ${
          (json as RestErrorResponse).error
        }`
      );
      return null;
    }
    return (json as RestSuccess<T>).result;
  } catch (err) {
    Logger.warn(
      `Bitrix24 REST ${method} failed: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Eager-load a Bitrix24 user once and cache it on the request scope. Used to
 * resolve `ID`-style references (e.g. task responsible, deal contact).
 *
 * Kept as a thin wrapper so call sites read clearly.
 *
 * @param user actor authorising the call.
 * @param userIds array of Bitrix24 user IDs to fetch.
 * @returns map ID → Bitrix24 user record (subset of fields we use).
 */
export async function fetchUsersByIds(
  user: User,
  userIds: number[]
): Promise<Record<string, Bitrix24UserSummary>> {
  if (userIds.length === 0) {
    return {};
  }
  const result = await callRest<Bitrix24UserSummary[]>(user, "user.get", {
    // Bitrix24's user.get accepts FILTER[ID] as an array of comma-separated
    // values; we pass IDs explicitly to avoid full-portal scans.
    "FILTER[ID]": userIds.map(String).join(","),
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

// Re-export `Op` from sequelize for any future query needs in callers — keeps
// downstream files free of direct sequelize imports.
export { Op };
