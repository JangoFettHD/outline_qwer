import Router from "koa-router";
import { z } from "zod";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import type { APIContext } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { isPortalUrl, searchPortal } from "../rest";
import { clamp } from "../unfurl";

const router = new Router();

/**
 * Body schema for `POST /api/zpqwer.search`. Mirrors the portal's own
 * contract: 2–120 character query, a type filter or "all", capped limit.
 */
const SearchSchema = z.object({
  body: z.object({
    query: z.string().max(120).default(""),
    type: z
      .enum(["project", "counterparty", "specialist", "service", "all"])
      .default("all"),
    limit: z.number().int().min(1).max(25).default(10),
  }),
});
type SearchReq = z.infer<typeof SearchSchema>;

router.post(
  "zpqwer.search",
  // The portal allows 60 searches per reader per minute — keep our own budget
  // below that so we never trip their limiter.
  rateLimiter(RateLimiterStrategy.TwentyFivePerMinute),
  auth(),
  validate(SearchSchema),
  async (ctx: APIContext<SearchReq>) => {
    const { user } = ctx.state.auth;
    const { query, type, limit } = ctx.input.body;

    const hits = await searchPortal(user, query, type, limit);
    ctx.body = {
      data: hits
        // Rows whose URL is not portal-hosted are dropped rather than shown.
        .filter((h) => isPortalUrl(h.url) && clamp(h.title, 160))
        .slice(0, limit)
        .map((h) => ({
          type: clamp(h.type, 40),
          id: clamp(h.id, 64),
          title: clamp(h.title, 160),
          subtitle: clamp(h.subtitle, 160) || undefined,
          url: h.url as string,
        })),
    };
  }
);

export default router;
