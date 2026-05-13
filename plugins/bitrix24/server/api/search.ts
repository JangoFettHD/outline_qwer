import Router from "koa-router";
import { z } from "zod";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import type { User } from "@server/models";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { buildBitrix24Url, type Bitrix24EntityType } from "../parser";
import { callRest, formatUserName, type Bitrix24UserSummary } from "../rest";

const router = new Router();

/**
 * Body schema for `POST /api/bitrix24.search`.
 *
 * `type` selects which Bitrix24 entity to look in. `query` is a free-text
 * substring; an empty string asks for recent / popular items of that type.
 */
const SearchSchema = z.object({
  body: z.object({
    type: z.enum([
      "workgroup",
      "task",
      "user",
      "chat",
      "deal",
      "contact",
      "company",
    ]),
    query: z.string().max(120).default(""),
    limit: z.number().int().min(1).max(25).default(10),
  }),
});
type SearchReq = z.infer<typeof SearchSchema>;

interface SearchHit {
  /** Entity type that produced this hit. */
  type: Bitrix24EntityType;
  /** Bitrix24 ID, stringified. */
  id: string;
  /** Human-readable title to render in the picker row. */
  title: string;
  /** Optional secondary line (description, role, etc). */
  subtitle?: string;
  /** Optional thumbnail/avatar URL. */
  avatarUrl?: string;
  /** Canonical Bitrix24 URL to insert into the document on selection. */
  url: string;
}

/**
 * Build a hit row that the client will render and, on selection, insert into
 * the document. The inserted URL is later resolved to a rich card by the
 * `Hook.UnfurlProvider` implementation in `unfurl.ts`.
 *
 * @param type entity type that produced the row.
 * @param id Bitrix24 entity id.
 * @param title primary line.
 * @param opts subtitle/avatar/groupId — all optional.
 * @returns SearchHit ready to be serialised.
 */
function hit(
  type: Bitrix24EntityType,
  id: string,
  title: string,
  opts: {
    subtitle?: string;
    avatarUrl?: string;
    groupId?: string;
  } = {}
): SearchHit {
  return {
    type,
    id,
    title,
    subtitle: opts.subtitle,
    avatarUrl: opts.avatarUrl,
    url: buildBitrix24Url({ type, id, groupId: opts.groupId }),
  };
}

router.post(
  "bitrix24.search",
  rateLimiter(RateLimiterStrategy.OneHundredPerHour),
  auth(),
  validate(SearchSchema),
  async (ctx: APIContext<SearchReq>) => {
    const { type, query, limit } = ctx.input.body;
    const { user } = ctx.state.auth;
    const q = query.trim();

    const hits = await searchByType(type, q, limit, user);
    ctx.body = { data: hits };
  }
);

/**
 * Dispatch the search to the right Bitrix24 REST method. Each branch
 * tolerates `q === ""` (returns recent / first N) so the picker can show
 * helpful defaults before the user types anything.
 *
 * @param type entity type to search.
 * @param q free-text substring (may be empty).
 * @param limit max number of results to return.
 * @param user actor.
 * @returns search hits, possibly empty.
 */
async function searchByType(
  type: Bitrix24EntityType,
  q: string,
  limit: number,
  user: User
): Promise<SearchHit[]> {
  switch (type) {
    case "workgroup":
      return searchWorkgroups(user, q, limit);
    case "task":
      return searchTasks(user, q, limit);
    case "user":
      return searchUsers(user, q, limit);
    case "chat":
      return searchChats(user, q, limit);
    case "deal":
      return searchDeals(user, q, limit);
    case "contact":
      return searchContacts(user, q, limit);
    case "company":
      return searchCompanies(user, q, limit);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Per-entity search implementations
// ────────────────────────────────────────────────────────────────────────────

async function searchWorkgroups(
  actor: User,
  q: string,
  limit: number
): Promise<SearchHit[]> {
  // sonet_group.get supports FILTER[%NAME] for substring matching.
  const params: Record<string, string | number> = { start: 0 };
  if (q) {
    params["FILTER[%NAME]"] = q;
  }
  const list = await callRest<Array<{
    ID: string;
    NAME: string;
    DESCRIPTION?: string;
    AVATAR?: string;
    CLOSED?: "Y" | "N";
  }>>(actor, "sonet_group.get", params);
  return (list ?? [])
    .filter((g) => g.CLOSED !== "Y")
    .slice(0, limit)
    .map((g) =>
      hit("workgroup", String(g.ID), g.NAME, {
        subtitle: g.DESCRIPTION,
        avatarUrl: g.AVATAR,
      })
    );
}

async function searchTasks(
  actor: User,
  q: string,
  limit: number
): Promise<SearchHit[]> {
  const filter: Record<string, string> = {};
  if (q) {
    filter["%TITLE"] = q;
  }
  const wrapped = await callRest<{
    tasks: Array<{
      id: string;
      title: string;
      groupId?: string;
      status?: string;
    }>;
  }>(actor, "tasks.task.list", {
    "select[]": ["ID", "TITLE", "GROUP_ID", "STATUS"],
    ...Object.fromEntries(
      Object.entries(filter).map(([k, v]) => [`filter[${k}]`, v])
    ),
    "order[ID]": "DESC",
    start: 0,
  });
  const items = wrapped?.tasks ?? [];
  return items.slice(0, limit).map((t) =>
    hit("task", String(t.id), t.title, {
      groupId: t.groupId,
    })
  );
}

async function searchUsers(
  actor: User,
  q: string,
  limit: number
): Promise<SearchHit[]> {
  // `user.search` filters by FIND parameter — exact match on substring.
  const params: Record<string, string | number> = {};
  if (q) {
    params.FIND = q;
  }
  const list = await callRest<Bitrix24UserSummary[]>(
    actor,
    "user.search",
    params
  );
  return (list ?? []).slice(0, limit).map((u) =>
    hit("user", String(u.ID), formatUserName(u), {
      subtitle: u.WORK_POSITION || u.EMAIL || undefined,
      avatarUrl: u.PERSONAL_PHOTO,
    })
  );
}

async function searchChats(
  actor: User,
  q: string,
  limit: number
): Promise<SearchHit[]> {
  // im.recent.get returns the user's recent chats; filter client-side by
  // title because Bitrix24 does not offer a server-side chat search.
  const list = await callRest<
    Array<{
      id: string;
      title: string;
      avatar?: string;
      chat?: { id: number | string; title?: string; avatar?: string };
    }>
  >(actor, "im.recent.get", {});
  const lcq = q.toLowerCase();
  const hits: SearchHit[] = [];
  for (const item of list ?? []) {
    const chatId =
      (item.chat?.id !== undefined ? String(item.chat.id) : "") ||
      (item.id?.startsWith("chat") ? item.id.slice(4) : "");
    if (!chatId) {
      continue; // direct DMs (id="N") — not supported for now
    }
    const title = item.chat?.title || item.title || `Chat #${chatId}`;
    if (lcq && !title.toLowerCase().includes(lcq)) {
      continue;
    }
    hits.push(
      hit("chat", chatId, title, {
        avatarUrl: item.chat?.avatar || item.avatar,
      })
    );
    if (hits.length >= limit) {
      break;
    }
  }
  return hits;
}

async function searchDeals(
  actor: User,
  q: string,
  limit: number
): Promise<SearchHit[]> {
  const params: Record<string, string | number> = {
    "select[]": "ID,TITLE,STAGE_ID,OPPORTUNITY,CURRENCY_ID",
    "order[ID]": "DESC",
    start: 0,
  };
  if (q) {
    params["filter[%TITLE]"] = q;
  }
  const list = await callRest<
    Array<{
      ID: string;
      TITLE: string;
      STAGE_ID?: string;
      OPPORTUNITY?: string;
      CURRENCY_ID?: string;
    }>
  >(actor, "crm.deal.list", params);
  return (list ?? []).slice(0, limit).map((d) =>
    hit("deal", String(d.ID), d.TITLE, {
      subtitle: [
        d.STAGE_ID,
        d.OPPORTUNITY && `${d.OPPORTUNITY} ${d.CURRENCY_ID ?? ""}`.trim(),
      ]
        .filter(Boolean)
        .join(" · "),
    })
  );
}

async function searchContacts(
  actor: User,
  q: string,
  limit: number
): Promise<SearchHit[]> {
  const params: Record<string, string | number> = {
    "select[]": "ID,NAME,LAST_NAME,POST,COMPANY_TITLE,EMAIL",
    "order[ID]": "DESC",
    start: 0,
  };
  if (q) {
    params["filter[%LAST_NAME]"] = q;
  }
  const list = await callRest<
    Array<{
      ID: string;
      NAME?: string;
      LAST_NAME?: string;
      POST?: string;
      COMPANY_TITLE?: string;
      EMAIL?: Array<{ VALUE: string }>;
    }>
  >(actor, "crm.contact.list", params);
  return (list ?? []).slice(0, limit).map((c) => {
    const name =
      [c.NAME, c.LAST_NAME].filter(Boolean).join(" ").trim() ||
      `Contact #${c.ID}`;
    const sub = [c.POST, c.COMPANY_TITLE, c.EMAIL?.[0]?.VALUE]
      .filter(Boolean)
      .join(" · ");
    return hit("contact", String(c.ID), name, { subtitle: sub });
  });
}

async function searchCompanies(
  actor: User,
  q: string,
  limit: number
): Promise<SearchHit[]> {
  const params: Record<string, string | number> = {
    "select[]": "ID,TITLE,INDUSTRY,COMPANY_TYPE",
    "order[ID]": "DESC",
    start: 0,
  };
  if (q) {
    params["filter[%TITLE]"] = q;
  }
  const list = await callRest<
    Array<{
      ID: string;
      TITLE?: string;
      INDUSTRY?: string;
      COMPANY_TYPE?: string;
    }>
  >(actor, "crm.company.list", params);
  return (list ?? []).slice(0, limit).map((c) =>
    hit("company", String(c.ID), c.TITLE ?? `Company #${c.ID}`, {
      subtitle: [c.INDUSTRY, c.COMPANY_TYPE].filter(Boolean).join(" · "),
    })
  );
}

export default router;
