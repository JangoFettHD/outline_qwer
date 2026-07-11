import { parse, parseISO, isValid } from "date-fns";
import { UnfurlResourceType } from "@shared/types";
import type { User } from "@server/models";
import type { Unfurl, UnfurlSignature } from "@server/types";
import env from "./env";
import { parseBitrix24Url, type ParsedBitrix24Url } from "./parser";
import {
  callRest,
  fetchUsersByIds,
  formatUserName,
  type Bitrix24UserSummary,
} from "./rest";

/**
 * Hex colour palette for state badges. Keys roughly map to Bitrix24 task
 * status codes and CRM stage semantic groups so the resulting card uses
 * sensible colours without requiring the caller to ship its own palette.
 */
const Color = {
  green: "#34a853",
  blue: "#1a73e8",
  orange: "#f9ab00",
  red: "#d93025",
  gray: "#80868b",
};

/**
 * Strip Bitrix24 markup from a description before it reaches the card. Task
 * descriptions arrive as BBCode (`[B]…[/B]`, `[URL=…]text[/URL]`); CRM
 * comments arrive as HTML (`<br>`, `<a>`). We render descriptions as plain
 * text, so leaving markup in produces both ugly literal tags AND — because
 * plain Bitrix24 links keep their description through the rich hover-preview
 * editor — a Markdown/link/image injection surface. Reducing to plain text
 * server-side removes both problems and bounds the cached payload size.
 *
 * @param input raw description/comments field from Bitrix24.
 * @param maxLength truncation ceiling (default 400 chars).
 * @returns cleaned, whitespace-collapsed, truncated plain text.
 */
function cleanBitrixText(
  input: string | null | undefined,
  maxLength = 400
): string | null {
  if (!input) {
    return null;
  }
  let s = input;
  // BBCode: keep the visible text of [URL=…]text[/URL] and [USER=…]text[/USER],
  // drop the rest of the tags.
  s = s.replace(/\[url=[^\]]*\]/gi, "").replace(/\[user=[^\]]*\]/gi, "");
  s = s.replace(/\[\/?[a-z][a-z0-9]*(=[^\]]*)?\]/gi, "");
  // HTML: <br> → newline, then strip remaining tags.
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  // Decode the handful of entities Bitrix24 emits.
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  // Collapse runs of whitespace but keep single newlines.
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > maxLength) {
    s = s.slice(0, maxLength - 1).trimEnd() + "…";
  }
  return s || null;
}

/**
 * Parse a Bitrix24 date string into a Date. Cloud portals return CRM/task
 * dates in ISO 8601, but calendar events come back in the portal's site
 * format (`dd.mm.yyyy hh:mm:ss` for a Russian portal). `new Date()` silently
 * mis-parses `dd.mm` as US `mm.dd`, so parse both shapes explicitly.
 *
 * @param value raw date string.
 * @returns a valid Date, or null.
 */
function parseBitrixDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const iso = parseISO(value);
  if (isValid(iso)) {
    return iso;
  }
  for (const fmt of [
    "dd.MM.yyyy HH:mm:ss",
    "dd.MM.yyyy HH:mm",
    "dd.MM.yyyy",
  ]) {
    const d = parse(value, fmt, new Date());
    if (isValid(d)) {
      return d;
    }
  }
  return null;
}

/**
 * Convert a raw Bitrix24 date string to an ISO 8601 string for card
 * `createdAt` fields, falling back to now when the value is missing or
 * unparseable (so the card's relative-time never renders "Invalid Date").
 *
 * @param value raw date string.
 * @returns an ISO 8601 timestamp.
 */
function toISO(value: string | null | undefined): string {
  return (parseBitrixDate(value) ?? new Date()).toISOString();
}

interface Bitrix24Status {
  ENTITY_ID: string;
  STATUS_ID: string;
  NAME: string;
}

/** Per-team cache of the CRM status dictionary (changes rarely). */
const statusListCache = new Map<string, { at: number; list: Bitrix24Status[] }>();
const STATUS_TTL_MS = 60 * 60 * 1000;

/**
 * Fetch (and cache) the portal's CRM status dictionary. Used to translate
 * machine codes like `C3:PREPARATION` / `UC_X4F2K1` into the human names an
 * admin configured (which is what readers expect on the card badge).
 *
 * @param actor caller authorising the REST read.
 * @returns array of status descriptors, possibly empty.
 */
async function getStatuses(actor: User): Promise<Bitrix24Status[]> {
  const cached = statusListCache.get(actor.teamId);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) {
    return cached.list;
  }
  const list =
    (await callRest<Bitrix24Status[]>(actor, "crm.status.list", { start: 0 })) ??
    [];
  statusListCache.set(actor.teamId, { at: Date.now(), list });
  return list;
}

/**
 * Resolve a deal STAGE_ID to its display name. Deals in non-default
 * pipelines carry a `C{categoryId}:` prefix, which maps to the
 * `DEAL_STAGE_{categoryId}` status entity.
 *
 * @param actor caller.
 * @param stageId raw STAGE_ID.
 * @returns display name, falling back to the raw code.
 */
async function dealStageName(
  actor: User,
  stageId: string | undefined
): Promise<string> {
  if (!stageId) {
    return "Open";
  }
  const statuses = await getStatuses(actor);
  const cat = /^C(\d+):/.exec(stageId);
  const entity = cat ? `DEAL_STAGE_${cat[1]}` : "DEAL_STAGE";
  const found =
    statuses.find((s) => s.ENTITY_ID === entity && s.STATUS_ID === stageId) ??
    statuses.find((s) => s.STATUS_ID === stageId);
  return found?.NAME ?? stageId;
}

/**
 * Resolve a lead STATUS_ID to its display name via the `STATUS` entity.
 *
 * @param actor caller.
 * @param statusId raw STATUS_ID.
 * @returns display name, falling back to the raw code.
 */
async function leadStatusName(
  actor: User,
  statusId: string | undefined
): Promise<string> {
  if (!statusId) {
    return "New";
  }
  const statuses = await getStatuses(actor);
  const found = statuses.find(
    (s) => s.ENTITY_ID === "STATUS" && s.STATUS_ID === statusId
  );
  return found?.NAME ?? statusId;
}

/**
 * Entry point registered as `Hook.UnfurlProvider`. Receives any URL pasted in
 * the editor and either returns a structured `Unfurl` payload (which Outline
 * renders as a rich card) or `undefined` to defer to the next provider /
 * iframely fallback.
 *
 * The function is intentionally permissive: any REST failure or missing
 * record returns `undefined`, never an error, so a temporary Bitrix24 outage
 * never breaks document rendering.
 */
export const unfurl: UnfurlSignature = async (
  url: string,
  actor?: User
): Promise<Unfurl | undefined> => {
  if (!actor) {
    return undefined;
  }
  const parsed = parseBitrix24Url(url);
  if (!parsed) {
    return undefined;
  }

  switch (parsed.type) {
    case "workgroup":
      return unfurlWorkgroup(parsed, url, actor);
    case "task":
      return unfurlTask(parsed, url, actor);
    case "user":
      return unfurlUser(parsed, actor);
    case "chat":
      return unfurlChat(parsed, url, actor);
    case "deal":
      return unfurlDeal(parsed, url, actor);
    case "contact":
      return unfurlContact(parsed, actor);
    case "company":
      return unfurlCompany(parsed, url, actor);
    case "lead":
      return unfurlLead(parsed, url, actor);
    case "event":
      return unfurlEvent(parsed, url, actor);
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Workgroup (project) → UnfurlResponse[Project]
// ────────────────────────────────────────────────────────────────────────────

interface Bitrix24Workgroup {
  ID: string;
  NAME: string;
  DESCRIPTION?: string;
  OWNER_ID?: string;
  IMAGE_ID?: string;
  CLOSED?: "Y" | "N";
  DATE_CREATE?: string;
  PROJECT_DATE_FINISH?: string;
  AVATAR?: string;
  AVATAR_TYPES?: { "100x100"?: string };
}

/**
 * Resolve a Bitrix24 workgroup (which Outline calls a "Project") to a
 * structured Project card. Project cards are the richest variant available —
 * they show name, description, owner, state, and target date.
 *
 * @param parsed URL descriptor with `id` set to the workgroup id.
 * @param url canonical workgroup URL — passed through to the card.
 * @param actor caller — authorises the REST call.
 * @returns project unfurl payload, or `undefined` if the workgroup is hidden
 *   from this user or no longer exists.
 */
async function unfurlWorkgroup(
  parsed: ParsedBitrix24Url,
  url: string,
  actor: User
): Promise<Unfurl | undefined> {
  const group = await callRest<Bitrix24Workgroup>(actor, "sonet_group.get", {
    "FILTER[ID]": parsed.id,
  }).then((arr) => (Array.isArray(arr) ? arr[0] : null));
  if (!group) {
    return undefined;
  }

  const owner = group.OWNER_ID
    ? (await fetchUsersByIds(actor, [Number(group.OWNER_ID)]))[group.OWNER_ID]
    : undefined;

  const closed = group.CLOSED === "Y";
  return {
    type: UnfurlResourceType.Project,
    url,
    id: String(group.ID),
    name: group.NAME,
    color: closed ? Color.gray : Color.blue,
    avatarUrl: group.AVATAR_TYPES?.["100x100"] || group.AVATAR,
    description: cleanBitrixText(group.DESCRIPTION),
    lead: owner
      ? {
          name: formatUserName(owner),
          avatarUrl: owner.PERSONAL_PHOTO ?? "",
        }
      : null,
    state: {
      name: closed ? "Archived" : "Active",
      color: closed ? Color.gray : Color.green,
      type: closed ? "completed" : "started",
    },
    labels: [],
    createdAt: toISO(group.DATE_CREATE),
    targetDate: parseBitrixDate(group.PROJECT_DATE_FINISH)?.toISOString() ?? null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Task → UnfurlResponse[Issue]
// ────────────────────────────────────────────────────────────────────────────

interface Bitrix24Task {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  createdBy?: string;
  responsibleId?: string;
  deadline?: string;
  createdDate?: string;
  groupId?: string;
}

/** Bitrix24 task status codes. */
const TaskStatus: Record<string, { name: string; color: string }> = {
  "1": { name: "New", color: Color.blue },
  "2": { name: "Pending", color: Color.blue },
  "3": { name: "In progress", color: Color.orange },
  "4": { name: "Supposedly completed", color: Color.green },
  "5": { name: "Completed", color: Color.green },
  "6": { name: "Deferred", color: Color.gray },
  "7": { name: "Declined", color: Color.red },
};

/**
 * Resolve a Bitrix24 task to an Issue-style card.
 *
 * @param parsed URL descriptor with `id` = task id.
 * @param url canonical task URL.
 * @param actor caller.
 * @returns issue unfurl payload, or `undefined`.
 */
async function unfurlTask(
  parsed: ParsedBitrix24Url,
  url: string,
  actor: User
): Promise<Unfurl | undefined> {
  // tasks.task.get returns a wrapped { task: {...} }, not a bare object —
  // unwrap it before mapping.
  const wrapped = await callRest<{ task: Bitrix24Task }>(
    actor,
    "tasks.task.get",
    {
      taskId: parsed.id,
      // Whitelisting fields keeps the response payload small.
      "select[]": [
        "ID",
        "TITLE",
        "DESCRIPTION",
        "STATUS",
        "CREATED_BY",
        "RESPONSIBLE_ID",
        "DEADLINE",
        "CREATED_DATE",
        "GROUP_ID",
      ],
    }
  );
  const task = wrapped?.task;
  if (!task) {
    return undefined;
  }

  const responsibleIds = [task.createdBy, task.responsibleId]
    .filter((v): v is string => !!v)
    .map(Number);
  const users = await fetchUsersByIds(actor, responsibleIds);
  const author = task.createdBy ? users[task.createdBy] : undefined;
  const status =
    TaskStatus[task.status ?? "2"] ?? { name: task.status ?? "—", color: Color.gray };

  return {
    type: UnfurlResourceType.Issue,
    url,
    id: String(task.id ?? parsed.id),
    title: task.title ?? `Task #${parsed.id}`,
    description: cleanBitrixText(task.description),
    author: {
      name: author ? formatUserName(author) : "—",
      avatarUrl: author?.PERSONAL_PHOTO ?? "",
    },
    labels: [],
    state: status,
    createdAt: toISO(task.createdDate),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// User → UnfurlResponse[Mention]
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a Bitrix24 user (employee) to a Mention-style card.
 *
 * @param parsed URL descriptor with `id` = user id.
 * @param actor caller.
 * @returns mention unfurl payload, or `undefined`.
 */
async function unfurlUser(
  parsed: ParsedBitrix24Url,
  actor: User
): Promise<Unfurl | undefined> {
  const users = await fetchUsersByIds(actor, [Number(parsed.id)]);
  const u: Bitrix24UserSummary | undefined = users[parsed.id];
  if (!u) {
    return undefined;
  }
  return {
    type: UnfurlResourceType.Mention,
    name: formatUserName(u),
    email: u.EMAIL ?? null,
    avatarUrl: u.PERSONAL_PHOTO ?? null,
    color: Color.blue,
    // The Mention card renders this slot as the subtitle; a job title is more
    // useful to a reader than a raw last-activity timestamp.
    lastActive: u.WORK_POSITION ?? "",
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Chat → UnfurlResponse[URL]   (Outline has no native chat card type)
// ────────────────────────────────────────────────────────────────────────────

interface Bitrix24Dialog {
  id?: number | string;
  title?: string;
  description?: string;
  avatar?: string;
  type?: string;
}

/**
 * Resolve a Bitrix24 group chat to a generic URL-style card with a thumbnail.
 * Outline lacks a first-class chat unfurl type, so we use the most flexible
 * one we have. Users get the chat name and avatar in the document and one
 * click takes them into Bitrix24 messenger.
 *
 * Uses `im.dialog.get` (which returns chat title/avatar/description directly),
 * not `im.chat.get` (which only echoes an ID). The dialog id for a group chat
 * is `chat{id}`.
 *
 * @param parsed URL descriptor with `id` = chat id (without the `chat` prefix).
 * @param url canonical chat URL — used as the card link.
 * @param actor caller.
 * @returns URL unfurl payload, or `undefined`.
 */
async function unfurlChat(
  parsed: ParsedBitrix24Url,
  url: string,
  actor: User
): Promise<Unfurl | undefined> {
  const dialog = await callRest<Bitrix24Dialog>(actor, "im.dialog.get", {
    DIALOG_ID: `chat${parsed.id}`,
  });
  if (!dialog || !dialog.title) {
    return undefined;
  }
  return {
    type: UnfurlResourceType.URL,
    url,
    title: dialog.title,
    description: cleanBitrixText(dialog.description) ?? "",
    thumbnailUrl: dialog.avatar ?? "",
    faviconUrl: faviconForPortal(),
    transformedUnfurl: true,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// CRM Deal → UnfurlResponse[Issue]
// ────────────────────────────────────────────────────────────────────────────

interface Bitrix24Deal {
  ID: string;
  TITLE: string;
  STAGE_ID?: string;
  ASSIGNED_BY_ID?: string;
  OPPORTUNITY?: string;
  CURRENCY_ID?: string;
  DATE_CREATE?: string;
  COMMENTS?: string;
  CLOSED?: "Y" | "N";
}

/**
 * Resolve a Bitrix24 CRM deal to an Issue-style card. Deal amount is
 * surfaced in the description so it is visible without opening the link.
 *
 * @param parsed URL descriptor with `id` = deal id.
 * @param url canonical deal URL.
 * @param actor caller.
 * @returns issue unfurl payload, or `undefined`.
 */
async function unfurlDeal(
  parsed: ParsedBitrix24Url,
  url: string,
  actor: User
): Promise<Unfurl | undefined> {
  const deal = await callRest<Bitrix24Deal>(actor, "crm.deal.get", {
    id: parsed.id,
  });
  if (!deal) {
    return undefined;
  }

  const responsible = deal.ASSIGNED_BY_ID
    ? (await fetchUsersByIds(actor, [Number(deal.ASSIGNED_BY_ID)]))[
        deal.ASSIGNED_BY_ID
      ]
    : undefined;

  const closed = deal.CLOSED === "Y";
  const amount = deal.OPPORTUNITY
    ? `${deal.OPPORTUNITY} ${deal.CURRENCY_ID ?? ""}`.trim()
    : null;
  const stageName = closed
    ? "Closed"
    : await dealStageName(actor, deal.STAGE_ID);

  return {
    type: UnfurlResourceType.Issue,
    url,
    id: String(deal.ID),
    title: deal.TITLE,
    description: cleanBitrixText(deal.COMMENTS),
    author: {
      name: responsible ? formatUserName(responsible) : "—",
      avatarUrl: responsible?.PERSONAL_PHOTO ?? "",
    },
    labels: amount ? [{ name: amount, color: Color.blue }] : [],
    state: {
      name: stageName,
      color: closed ? Color.gray : Color.green,
    },
    createdAt: toISO(deal.DATE_CREATE),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// CRM Contact / Company → UnfurlResponse[Mention] / [URL]
// ────────────────────────────────────────────────────────────────────────────

interface Bitrix24Contact {
  ID: string;
  NAME?: string;
  LAST_NAME?: string;
  EMAIL?: Array<{ VALUE: string; VALUE_TYPE?: string }>;
  PHONE?: Array<{ VALUE: string }>;
  COMPANY_TITLE?: string;
  POST?: string;
}

/**
 * Resolve a CRM contact to a Mention-style card. Their company is exposed in
 * `lastActive` as a small subtitle.
 *
 * @param parsed URL descriptor with `id` = contact id.
 * @param actor caller.
 * @returns mention unfurl payload, or `undefined`.
 */
async function unfurlContact(
  parsed: ParsedBitrix24Url,
  actor: User
): Promise<Unfurl | undefined> {
  const c = await callRest<Bitrix24Contact>(actor, "crm.contact.get", {
    id: parsed.id,
  });
  if (!c) {
    return undefined;
  }
  const name =
    [c.NAME, c.LAST_NAME].filter(Boolean).join(" ").trim() || `Contact #${c.ID}`;
  const email = c.EMAIL?.[0]?.VALUE ?? null;
  const subtitleBits = [c.POST, c.COMPANY_TITLE].filter(Boolean);
  return {
    type: UnfurlResourceType.Mention,
    name,
    email,
    avatarUrl: null,
    color: Color.blue,
    lastActive: subtitleBits.join(" · "),
  };
}

interface Bitrix24Company {
  ID: string;
  TITLE?: string;
  COMPANY_TYPE?: string;
  INDUSTRY?: string;
  ASSIGNED_BY_ID?: string;
  EMPLOYEES?: string;
  WEB?: Array<{ VALUE: string }>;
  COMMENTS?: string;
  DATE_CREATE?: string;
}

/**
 * Resolve a CRM company to a URL-style card. We do not have a structured
 * Company shape in Outline's unfurl types, so we serialise basic info into
 * the description.
 *
 * @param parsed URL descriptor with `id` = company id.
 * @param url canonical company URL.
 * @param actor caller.
 * @returns URL unfurl payload, or `undefined`.
 */
async function unfurlCompany(
  parsed: ParsedBitrix24Url,
  url: string,
  actor: User
): Promise<Unfurl | undefined> {
  const co = await callRest<Bitrix24Company>(actor, "crm.company.get", {
    id: parsed.id,
  });
  if (!co) {
    return undefined;
  }
  const descBits = [co.INDUSTRY, co.EMPLOYEES, co.WEB?.[0]?.VALUE].filter(
    Boolean
  );
  return {
    type: UnfurlResourceType.URL,
    url,
    title: co.TITLE ?? `Company #${co.ID}`,
    description: descBits.join(" · ") || cleanBitrixText(co.COMMENTS) || "",
    thumbnailUrl: "",
    faviconUrl: faviconForPortal(),
    transformedUnfurl: true,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// CRM Lead → UnfurlResponse[Issue]
// ────────────────────────────────────────────────────────────────────────────

interface Bitrix24Lead {
  ID: string;
  TITLE: string;
  NAME?: string;
  LAST_NAME?: string;
  STATUS_ID?: string;
  OPPORTUNITY?: string;
  CURRENCY_ID?: string;
  ASSIGNED_BY_ID?: string;
  COMPANY_TITLE?: string;
  DATE_CREATE?: string;
  COMMENTS?: string;
}

/**
 * Resolve a Bitrix24 CRM lead to an Issue-style card. Surfaces the lead's
 * status, responsible person, optional amount, and company in the subtitle.
 *
 * @param parsed URL descriptor with `id` = lead id.
 * @param url canonical lead URL.
 * @param actor caller.
 * @returns issue unfurl payload, or `undefined`.
 */
async function unfurlLead(
  parsed: ParsedBitrix24Url,
  url: string,
  actor: User
): Promise<Unfurl | undefined> {
  const lead = await callRest<Bitrix24Lead>(actor, "crm.lead.get", {
    id: parsed.id,
  });
  if (!lead) {
    return undefined;
  }

  const responsible = lead.ASSIGNED_BY_ID
    ? (await fetchUsersByIds(actor, [Number(lead.ASSIGNED_BY_ID)]))[
        lead.ASSIGNED_BY_ID
      ]
    : undefined;
  const amount = lead.OPPORTUNITY
    ? `${lead.OPPORTUNITY} ${lead.CURRENCY_ID ?? ""}`.trim()
    : null;

  // Lead title is sometimes the literal "TITLE", sometimes synthesised from
  // first+last. Fall back to a "#ID" placeholder so the card is never blank.
  const title =
    lead.TITLE ||
    [lead.NAME, lead.LAST_NAME].filter(Boolean).join(" ").trim() ||
    `Lead #${lead.ID}`;
  const statusName = await leadStatusName(actor, lead.STATUS_ID);

  return {
    type: UnfurlResourceType.Issue,
    url,
    id: String(lead.ID),
    title,
    description: cleanBitrixText(lead.COMMENTS),
    author: {
      name: responsible ? formatUserName(responsible) : "—",
      avatarUrl: responsible?.PERSONAL_PHOTO ?? "",
    },
    labels: [
      ...(amount ? [{ name: amount, color: Color.blue }] : []),
      ...(lead.COMPANY_TITLE
        ? [{ name: lead.COMPANY_TITLE, color: Color.gray }]
        : []),
    ],
    state: {
      name: statusName,
      color: Color.blue,
    },
    createdAt: toISO(lead.DATE_CREATE),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Calendar event → UnfurlResponse[Issue]
// ────────────────────────────────────────────────────────────────────────────

interface Bitrix24Event {
  ID: string | number;
  NAME?: string;
  DESCRIPTION?: string;
  CREATED_BY?: string | number;
  DATE_FROM?: string;
  DATE_TO?: string;
  ACCESSIBILITY?: string;
  IS_MEETING?: boolean;
  LOCATION?: string;
}

/**
 * Resolve a Bitrix24 calendar event to an Issue-style card. The event's start
 * date is used as the state label so users can see at a glance when it
 * happens.
 *
 * @param parsed URL descriptor with `id` = event id.
 * @param url canonical event URL.
 * @param actor caller.
 * @returns issue unfurl payload, or `undefined`.
 */
async function unfurlEvent(
  parsed: ParsedBitrix24Url,
  url: string,
  actor: User
): Promise<Unfurl | undefined> {
  // calendar.event.getbyid is the most direct method; it returns the event by
  // its primary key regardless of which calendar it belongs to.
  const event = await callRest<Bitrix24Event>(actor, "calendar.event.getbyid", {
    id: parsed.id,
  });
  if (!event) {
    return undefined;
  }

  const creator = event.CREATED_BY
    ? (await fetchUsersByIds(actor, [Number(event.CREATED_BY)]))[
        String(event.CREATED_BY)
      ]
    : undefined;

  const dateBadge = formatEventDateBadge(event.DATE_FROM, event.DATE_TO);
  const dateTo = parseBitrixDate(event.DATE_TO);
  const isPast = dateTo ? dateTo.getTime() < Date.now() : false;

  return {
    type: UnfurlResourceType.Issue,
    url,
    id: String(event.ID),
    title: event.NAME ?? `Event #${event.ID}`,
    description: cleanBitrixText(event.DESCRIPTION),
    author: {
      name: creator ? formatUserName(creator) : "—",
      avatarUrl: creator?.PERSONAL_PHOTO ?? "",
    },
    labels: event.LOCATION
      ? [{ name: event.LOCATION, color: Color.gray }]
      : [],
    state: {
      name: dateBadge,
      color: isPast ? Color.gray : Color.green,
    },
    createdAt: toISO(event.DATE_FROM),
  };
}

/**
 * Format the event's start/end dates as a compact human-readable badge
 * suitable for the `state.name` field of the Issue card. Parses Bitrix24's
 * site-format dates explicitly (not via `new Date()`, which mis-reads
 * `dd.mm` as US `mm.dd`).
 *
 * @param from raw start date.
 * @param to raw end date.
 * @returns short date range like "13 May, 10:00–11:30", or "—" if unparseable.
 */
function formatEventDateBadge(from?: string, to?: string): string {
  const start = parseBitrixDate(from);
  if (!start) {
    return "—";
  }
  const end = parseBitrixDate(to);
  const sameDay =
    end &&
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();

  const fmtDate = (d: Date) =>
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const fmtTime = (d: Date) =>
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  if (!end) {
    return fmtDate(start);
  }
  if (sameDay) {
    return `${fmtDate(start)}, ${fmtTime(start)}–${fmtTime(end)}`;
  }
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Misc
// ────────────────────────────────────────────────────────────────────────────

/**
 * Return a URL pointing to the configured portal's favicon, read from the
 * validated plugin env (not process.env directly).
 *
 * @returns favicon URL, or empty string when no portal is configured.
 */
function faviconForPortal(): string {
  const base = (env.BITRIX24_PORTAL_URL ?? "").replace(/\/$/, "");
  return base ? `${base}/favicon.ico` : "";
}
