import Logger from "@server/logging/Logger";
import { AuthenticationProvider, UserAuthentication } from "@server/models";
import type { User } from "@server/models";
import { CacheHelper } from "@server/utils/CacheHelper";
import fetch from "@server/utils/fetch";
import { Minute } from "@shared/utils/time";
import env from "./env";
import type { ZpqwerEntityType } from "./parser";

/** Timeout for every staff-portal request. */
const REQUEST_TIMEOUT_MS = 10_000;

/** How long the reader's portal id is remembered (it never changes). */
const ACTOR_CACHE_SECONDS = 5 * Minute.seconds;

/** Sentinel cached for readers who have no portal identity, to skip requeries. */
const NO_ACTOR = "-";

/**
 * The portal identifies readers by their Bitrix24 portal id, which Outline
 * already stores on the Bitrix24 UserAuthentication row at sign-in.
 */
const BITRIX24_PROVIDER = "bitrix24";

/** One card as returned by `GET /api/ext/v1/card`. */
export interface ZpqwerCard {
  type?: unknown;
  id?: unknown;
  title?: unknown;
  subtitle?: unknown;
  url?: unknown;
  imageUrl?: unknown;
  fields?: unknown;
  links?: unknown;
}

/** One row as returned by `GET /api/ext/v1/search`. */
export interface ZpqwerSearchHit {
  type?: unknown;
  id?: unknown;
  title?: unknown;
  subtitle?: unknown;
  url?: unknown;
}

/**
 * True when the value is an absolute URL served by the configured portal.
 * Everything the contract returns is portal-hosted, so anything else is
 * either a mistake or hostile and is dropped rather than rendered.
 *
 * @param value candidate URL.
 * @returns whether it is safe to use as an href or image source.
 */
export function isPortalUrl(value: unknown): value is string {
  if (typeof value !== "string" || !env.ZPQWER_BASE_URL) {
    return false;
  }
  try {
    const u = new URL(value);
    const base = new URL(env.ZPQWER_BASE_URL);
    return u.protocol === base.protocol && u.host === base.host;
  } catch (_err) {
    return false;
  }
}

/**
 * True for absolute http(s) URLs on any host — used for the portal's
 * `links[]`, which deliberately point at Bitrix24 and the public site.
 *
 * @param value candidate URL.
 * @returns whether it is a plain http(s) URL.
 */
export function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value);
}

/**
 * Resolve the acting reader's Bitrix24 portal id, which the staff portal uses
 * to decide whether the reader is an employee at all. Cached briefly because
 * a document full of cards would otherwise repeat two queries per card, and
 * for most readers the answer is a stable "not linked".
 *
 * @param user Outline user performing the request.
 * @returns the portal id, or `null` when the user never signed in via
 *   Bitrix24 (in which case the portal would answer 404 anyway).
 */
async function getActorId(user: User): Promise<string | null> {
  const cached = await CacheHelper.getDataOrSet<string>(
    `zpqwer:actor:${user.id}`,
    async () => {
      const provider = await AuthenticationProvider.findOne({
        where: { name: BITRIX24_PROVIDER, teamId: user.teamId },
      });
      if (!provider) {
        return NO_ACTOR;
      }
      const auth = await UserAuthentication.findOne({
        where: { userId: user.id, authenticationProviderId: provider.id },
        order: [["createdAt", "DESC"]],
      });
      return auth?.providerId ?? NO_ACTOR;
    },
    ACTOR_CACHE_SECONDS
  );
  return !cached || cached === NO_ACTOR ? null : cached;
}

/**
 * Call the staff portal's read-only API on behalf of a user.
 *
 * Every failure degrades to `null` so a portal outage, an unmapped reader, a
 * rate limit or a malformed body renders as a plain link rather than an
 * error. Nothing from the response body is logged: it carries staff data.
 *
 * @param user acting reader; supplies the `X-ZPQWER-Actor` header.
 * @param path path under `/api/ext/v1`, e.g. `card`.
 * @param params query parameters.
 * @returns parsed JSON body, or `null`.
 */
async function call<T>(
  user: User,
  path: string,
  params: Record<string, string | number>
): Promise<T | null> {
  if (!env.ZPQWER_BASE_URL || !env.ZPQWER_API_KEY) {
    return null;
  }

  try {
    const actor = await getActorId(user);
    if (!actor) {
      // Reader is not linked to the portal — the API would answer 404.
      return null;
    }

    const url = new URL(
      `${env.ZPQWER_BASE_URL.replace(/\/$/, "")}/api/ext/v1/${path}`
    );
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        // Key travels in a header, never the query string, so it stays out of
        // access logs and Referer.
        "X-ZPQWER-Key": env.ZPQWER_API_KEY,
        "X-ZPQWER-Actor": `bitrix:${actor}`,
        "X-ZPQWER-Consumer": "outline",
        Accept: "application/json",
      },
      timeout: REQUEST_TIMEOUT_MS,
    });

    if (res.status === 404) {
      // Either no such entity or the reader is not recognised as staff — the
      // portal deliberately does not distinguish the two.
      return null;
    }
    if (!res.ok) {
      // Status and path only: the body may contain staff data.
      Logger.warn(`ZPQWER ${path} responded ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    Logger.warn(`ZPQWER ${path} failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Fetch a single card.
 *
 * @param user acting reader.
 * @param type entity type.
 * @param id entity id (UUID, or slug for services).
 * @returns the card, or `null`.
 */
export function fetchCard(
  user: User,
  type: ZpqwerEntityType,
  id: string
): Promise<ZpqwerCard | null> {
  return call<ZpqwerCard>(user, "card", { type, id });
}

/**
 * Search the portal's directories.
 *
 * @param user acting reader.
 * @param q free-text query (the portal requires 2–120 characters).
 * @param type entity type to scope to, or "all".
 * @param limit maximum rows (portal caps at 25).
 * @returns matching rows, possibly empty.
 */
export async function searchPortal(
  user: User,
  q: string,
  type: string,
  limit: number
): Promise<ZpqwerSearchHit[]> {
  if (q.trim().length < 2) {
    return [];
  }
  const res = await call<{ results?: unknown }>(user, "search", {
    q: q.trim().slice(0, 120),
    type,
    limit,
  });
  return Array.isArray(res?.results) ? (res.results as ZpqwerSearchHit[]) : [];
}
