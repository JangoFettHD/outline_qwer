import Router from "koa-router";
import { Minute } from "@shared/utils/time";
import { PluginManager, Hook, type Plugin } from "@server/utils/PluginManager";
import config from "../plugin.json";
import createTaskRouter from "./api/createTask";
import searchRouter from "./api/search";
import webhooksRouter from "./api/webhooks";
import router from "./auth/bitrix24";
import env from "./env";
import Bitrix24NotificationsProcessor from "./processors/Bitrix24NotificationsProcessor";
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
  // Hook.API expects a single Koa router per plugin, but we have several
  // route groups. Merge them into one router so the PluginManager keeps a
  // flat registration list.
  const apiRouter = new Router();
  apiRouter.use(searchRouter.routes());
  apiRouter.use(createTaskRouter.routes());
  apiRouter.use(webhooksRouter.routes());

  const hooks: Array<Plugin<Hook>> = [
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
    // REST endpoints: search, createTask, and the inbound webhook.
    {
      ...config,
      type: Hook.API,
      value: apiRouter,
    },
  ];

  // Mention → Bitrix24 messenger bridge. Only registered when an incoming
  // webhook (service credential) is configured, since that is what delivers
  // the notification.
  if (env.BITRIX24_WEBHOOK_URL) {
    hooks.push({
      type: Hook.Processor,
      value: Bitrix24NotificationsProcessor,
    });
  }

  PluginManager.add(hooks);
}
