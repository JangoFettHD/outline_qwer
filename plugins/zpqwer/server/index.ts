import Router from "koa-router";
import { Minute } from "@shared/utils/time";
import { PluginManager, Hook, type Plugin } from "@server/utils/PluginManager";
import config from "../plugin.json";
import searchRouter from "./api/search";
import env from "./env";
import { unfurl } from "./unfurl";

/**
 * The plugin activates once an admin supplies the portal URL and the shared
 * service key. Without both, every hook would be a no-op, so we register
 * nothing at all.
 */
const enabled = !!env.ZPQWER_BASE_URL && !!env.ZPQWER_API_KEY;

if (enabled) {
  const apiRouter = new Router();
  apiRouter.use(searchRouter.routes());

  const hooks: Array<Plugin<Hook>> = [
    // Hover previews over plain staff-portal links.
    {
      type: Hook.UnfurlProvider,
      value: { unfurl, cacheExpiry: 5 * Minute.seconds },
    },
    // `zpqwer.search` — backs the inline picker and Cmd+K results.
    {
      ...config,
      type: Hook.API,
      value: apiRouter,
    },
  ];

  PluginManager.add(hooks);
}
