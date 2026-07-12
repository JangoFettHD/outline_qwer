import Router from "koa-router";
import { AuthenticationProvider } from "@server/models";
import Logger from "@server/logging/Logger";
import type { APIContext } from "@server/types";
import { CacheHelper } from "@server/utils/CacheHelper";
import { RedisPrefixHelper } from "@server/utils/RedisPrefixHelper";
import { safeEqual } from "@server/utils/crypto";
import config from "../../plugin.json";
import env from "../env";

const router = new Router();

/**
 * Shape of the fields we read from a Bitrix24 outbound event POST. Bitrix24
 * sends `application/x-www-form-urlencoded` with nested keys, which koa-body
 * parses into this structure.
 */
interface Bitrix24EventBody {
  event?: string;
  auth?: { application_token?: string };
}

/**
 * Inbound endpoint for Bitrix24 outbound event handlers (ONTASKUPDATE,
 * ONCRMDEALUPDATE, …). Authenticated by the handler's `application_token`
 * shared secret. On any recognised change event we clear this team's unfurl
 * cache so the affected card re-fetches on next view instead of waiting out
 * the 5-minute TTL.
 *
 * We clear the whole team unfurl prefix rather than a single URL because the
 * cache is keyed per-user (each viewer resolves with their own token), so a
 * single entity maps to many keys; for a single-team install the occasional
 * re-fetch of other cards is negligible.
 */
router.post(
  "bitrix24.webhooks",
  async (ctx: APIContext) => {
    const token = env.BITRIX24_WEBHOOK_TOKEN;
    if (!token) {
      ctx.status = 404;
      return;
    }

    const body = (ctx.request.body ?? {}) as Bitrix24EventBody;
    const provided = body.auth?.application_token;
    if (!provided || !safeEqual(provided, token)) {
      ctx.status = 401;
      return;
    }

    // Resolve the single team that owns the Bitrix24 auth provider.
    const provider = await AuthenticationProvider.findOne({
      where: { name: config.id },
    });
    if (provider) {
      await CacheHelper.clearData(
        RedisPrefixHelper.getUnfurlKey(provider.teamId)
      );
      Logger.info("plugins", "Bitrix24 event cleared unfurl cache", {
        event: body.event,
        teamId: provider.teamId,
      });
    }

    // Acknowledge quickly; Bitrix24 retries on non-2xx.
    ctx.status = 200;
    ctx.body = { ok: true };
  }
);

export default router;
