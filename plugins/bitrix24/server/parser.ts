import env from "./env";

/**
 * The kinds of Bitrix24 entities this plugin can resolve. The string values
 * double as type discriminators in the REST API responses and in the slash
 * search payloads, so they should not be renamed without updating callers.
 */
export type Bitrix24EntityType =
  | "workgroup"
  | "task"
  | "user"
  | "chat"
  | "deal"
  | "contact"
  | "company"
  | "lead"
  | "event";

export interface ParsedBitrix24Url {
  type: Bitrix24EntityType;
  /** Primary numeric ID — task ID, group ID, deal ID, etc. */
  id: string;
  /** Group ID if the URL is a sub-resource of a workgroup (currently tasks). */
  groupId?: string;
}

/**
 * Regexes matching the path portion of a Bitrix24 URL. Ordered most-specific
 * first — task URLs nest under workgroup URLs, so the workgroup-task pattern
 * must match before the bare workgroup pattern.
 */
const PATH_PATTERNS: Array<{
  type: Bitrix24EntityType;
  re: RegExp;
  /** Indexes of capture groups: [primary id, optional secondary id]. */
  ids: [number, number?];
  /** Whether the primary id is actually the second capture (e.g. tasks). */
  secondaryIsPrimary?: boolean;
}> = [
  // /workgroups/group/56/tasks/task/view/123/ → task 123 inside group 56
  {
    type: "task",
    re: /^\/workgroups\/group\/(\d+)\/tasks\/task\/view\/(\d+)/,
    ids: [2, 1],
    secondaryIsPrimary: true,
  },
  // /company/personal/user/7/tasks/task/view/123/ → task 123 (no group)
  {
    type: "task",
    re: /^\/company\/personal\/user\/\d+\/tasks\/task\/view\/(\d+)/,
    ids: [1],
  },
  // /workgroups/group/56/ → workgroup 56 (matches /workgroups/group/56/tasks/ too)
  {
    type: "workgroup",
    re: /^\/workgroups\/group\/(\d+)/,
    ids: [1],
  },
  // /company/personal/user/7/ → user 7
  {
    type: "user",
    re: /^\/company\/personal\/user\/(\d+)/,
    ids: [1],
  },
  // /crm/deal/details/42/ → deal 42
  {
    type: "deal",
    re: /^\/crm\/deal\/details\/(\d+)/,
    ids: [1],
  },
  // /crm/contact/details/42/
  {
    type: "contact",
    re: /^\/crm\/contact\/details\/(\d+)/,
    ids: [1],
  },
  // /crm/company/details/42/
  {
    type: "company",
    re: /^\/crm\/company\/details\/(\d+)/,
    ids: [1],
  },
  // /crm/lead/details/42/
  {
    type: "lead",
    re: /^\/crm\/lead\/details\/(\d+)/,
    ids: [1],
  },
];

/**
 * Try to parse a Bitrix24 URL. Returns `null` if the URL does not point to
 * the configured Bitrix24 portal or does not match a recognised entity.
 *
 * @param raw the URL as it appears in the document (pasted / typed).
 * @returns parsed entity descriptor or `null`.
 */
export function parseBitrix24Url(raw: string): ParsedBitrix24Url | null {
  if (!env.BITRIX24_PORTAL_URL) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch (_err) {
    return null;
  }

  const portal = new URL(env.BITRIX24_PORTAL_URL);
  if (url.hostname.toLowerCase() !== portal.hostname.toLowerCase()) {
    return null;
  }

  // Chat URLs encode the dialog id in a query parameter — handle separately.
  const chatMatch = matchChatUrl(url);
  if (chatMatch) {
    return chatMatch;
  }

  // Calendar event URLs use a query parameter (EVENT_ID) rather than a path,
  // so they don't fit the standard PATH_PATTERNS table either.
  const eventMatch = matchEventUrl(url);
  if (eventMatch) {
    return eventMatch;
  }

  for (const pattern of PATH_PATTERNS) {
    const m = pattern.re.exec(url.pathname);
    if (!m) {
      continue;
    }
    const primary = m[pattern.ids[0]];
    const secondary =
      pattern.ids[1] !== undefined ? m[pattern.ids[1]] : undefined;
    if (pattern.secondaryIsPrimary && pattern.ids[1] !== undefined) {
      // For tasks under a workgroup, the URL is /workgroups/group/G/.../task/T,
      // so the *primary* id is the task (capture group 2) and the secondary is
      // the group id (capture group 1). The `ids` tuple already encodes that.
      return {
        type: pattern.type,
        id: m[pattern.ids[0]],
        groupId: secondary,
      };
    }
    return { type: pattern.type, id: primary, groupId: secondary };
  }

  return null;
}

/**
 * Match Bitrix24 chat / messenger URLs, e.g.
 *   https://qwer.bitrix24.ru/online/?IM_DIALOG=chat42
 *   https://qwer.bitrix24.ru/im/messenger/?IM_DIALOG=42
 *
 * The dialog id may be a chat (`chatN`) or a direct DM (`N` = user id). We
 * only return cards for group chats; DMs fall through to the URL fallback in
 * the unfurl path.
 *
 * @param url parsed URL object.
 * @returns descriptor for chat entity, or `null` if not a chat URL.
 */
function matchChatUrl(url: URL): ParsedBitrix24Url | null {
  const onlineOrMessenger =
    url.pathname.startsWith("/online") ||
    url.pathname.startsWith("/im/messenger");
  if (!onlineOrMessenger) {
    return null;
  }
  const dialog = url.searchParams.get("IM_DIALOG");
  if (!dialog) {
    return null;
  }
  const m = /^chat(\d+)$/.exec(dialog);
  if (!m) {
    return null;
  }
  return { type: "chat", id: m[1] };
}

/**
 * Match Bitrix24 calendar event URLs. Bitrix renders events at
 *   https://qwer.bitrix24.ru/calendar/?EVENT_ID=42
 * (or `event=edit&EVENT_ID=42` for the edit modal). We only care about the
 * EVENT_ID query parameter — any path under `/calendar/` is fair game.
 *
 * @param url parsed URL.
 * @returns descriptor for calendar event, or `null`.
 */
function matchEventUrl(url: URL): ParsedBitrix24Url | null {
  if (!url.pathname.startsWith("/calendar")) {
    return null;
  }
  const id = url.searchParams.get("EVENT_ID");
  if (!id || !/^\d+$/.test(id)) {
    return null;
  }
  return { type: "event", id };
}

/**
 * Build a canonical Bitrix24 URL for an entity, used by the search API to
 * return URLs that the editor can insert and which the unfurl pipeline will
 * later resolve back to a card.
 *
 * @param entity descriptor matching what the search REST methods return.
 * @returns absolute URL on the configured portal.
 */
export function buildBitrix24Url(entity: ParsedBitrix24Url): string {
  const base = env.BITRIX24_PORTAL_URL!.replace(/\/$/, "");
  switch (entity.type) {
    case "workgroup":
      return `${base}/workgroups/group/${entity.id}/`;
    case "task":
      if (entity.groupId) {
        return `${base}/workgroups/group/${entity.groupId}/tasks/task/view/${entity.id}/`;
      }
      return `${base}/company/personal/user/0/tasks/task/view/${entity.id}/`;
    case "user":
      return `${base}/company/personal/user/${entity.id}/`;
    case "chat":
      return `${base}/online/?IM_DIALOG=chat${entity.id}`;
    case "deal":
      return `${base}/crm/deal/details/${entity.id}/`;
    case "contact":
      return `${base}/crm/contact/details/${entity.id}/`;
    case "company":
      return `${base}/crm/company/details/${entity.id}/`;
    case "lead":
      return `${base}/crm/lead/details/${entity.id}/`;
    case "event":
      return `${base}/calendar/?EVENT_ID=${entity.id}`;
  }
}
