import Router from "koa-router";
import { Minute } from "@shared/utils/time";
import { PluginManager, Hook } from "@server/utils/PluginManager";
import config from "../plugin.json";
import createTaskRouter from "./api/createTask";
import searchRouter from "./api/search";
import router from "./auth/bitrix24";
import env from "./env";
import { unfurl } from "./unfurl";

/**
 * The plugin is fully enabled once an admin has provided the OAuth credentials
 * and the portal URL. All hooks below — login provider, unfurl, and search
 * API — assume those values are present, so we gate everything on the same
 * three vars.
 */
const enabled =
  !!env.BITRIX24_CLIENT_ID &&
  !!env.BITRIX24_CLIENT_SECRET &&
  !!env.BITRIX24_PORTAL_URL;

if (enabled) {
  // Hook.API expects a single Koa router per plugin, but we have two distinct
  // route groups (search, createTask). Merge them into one router so the
  // PluginManager keeps a flat registration list.
  const apiRouter = new Router();
  apiRouter.use(searchRouter.routes());
  apiRouter.use(createTaskRouter.routes());

  PluginManager.add([
    // OAuth login provider — adds "Continue with Bitrix24" on the sign-in page.
    {
      ...config,
      type: Hook.AuthProvider,
      value: { router, id: config.id },
    },
    // Unfurl provider — turns pasted Bitrix24 URLs into rich cards.
    // 5-minute cache balances "fresh data" against REST quota usage.
    {
      type: Hook.UnfurlProvider,
      value: { unfurl, cacheExpiry: 5 * Minute.seconds },
    },
    // Combined REST endpoint router: `bitrix24.search` + `bitrix24.createTask`.
    {
      ...config,
      type: Hook.API,
      value: apiRouter,
    },
  ]);
}
