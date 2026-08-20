import env from "./env";

/**
 * Entity types the staff portal's card API understands. The strings are sent
 * verbatim as the `type` query parameter, so they must match the portal's
 * contract exactly.
 */
export type ZpqwerEntityType =
  | "project"
  | "counterparty"
  | "specialist"
  | "estimate"
  | "service";

export interface ParsedZpqwerUrl {
  type: ZpqwerEntityType;
  /** UUID for most types; a text slug for `service`. */
  id: string;
}

const UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Path patterns that map a staff-portal URL onto a card request. Kept in sync
 * with section 6 of the portal's EXT_API contract.
 */
const PATTERNS: Array<{ type: ZpqwerEntityType; re: RegExp }> = [
  { type: "project", re: new RegExp(`^/admin/projects/(${UUID.source})`, "i") },
  {
    type: "counterparty",
    re: new RegExp(`^/admin/counterparties/(${UUID.source})`, "i"),
  },
  {
    type: "specialist",
    re: new RegExp(`^/admin/specialists/(${UUID.source})`, "i"),
  },
  { type: "estimate", re: new RegExp(`^/sales/calc/(${UUID.source})`, "i") },
  // Services are addressed by slug rather than UUID.
  { type: "service", re: /^\/sales\/services\/([a-z0-9_-]{2,64})/i },
];

/**
 * Parse a staff-portal URL into a card request. Returns `null` when the URL
 * points elsewhere or does not name a card-able entity.
 *
 * @param raw URL as it appears in the document.
 * @returns parsed entity descriptor, or `null`.
 */
export function parseZpqwerUrl(raw: string): ParsedZpqwerUrl | null {
  if (!env.ZPQWER_BASE_URL) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch (_err) {
    return null;
  }

  const portal = new URL(env.ZPQWER_BASE_URL);
  if (url.hostname.toLowerCase() !== portal.hostname.toLowerCase()) {
    return null;
  }

  for (const { type, re } of PATTERNS) {
    const m = re.exec(url.pathname);
    if (m) {
      return { type, id: m[1] };
    }
  }
  return null;
}
