import { PluginManager, Hook } from "@server/utils/PluginManager";
import config from "../plugin.json";
import router from "./auth/bitrix24";
import env from "./env";

const enabled =
  !!env.BITRIX24_CLIENT_ID &&
  !!env.BITRIX24_CLIENT_SECRET &&
  !!env.BITRIX24_PORTAL_URL;

if (enabled) {
  PluginManager.add([
    {
      ...config,
      type: Hook.AuthProvider,
      value: { router, id: config.id },
    },
  ]);
}
