import { IsOptional, IsUrl } from "class-validator";
import { Environment } from "@server/env";
import environment from "@server/utils/environment";
import { CannotUseWithout } from "@server/utils/validators";

class Bitrix24PluginEnvironment extends Environment {
  /**
   * Bitrix24 OAuth2 client credentials. Required to enable authentication.
   */
  @IsOptional()
  @CannotUseWithout("BITRIX24_CLIENT_SECRET")
  @CannotUseWithout("BITRIX24_PORTAL_URL")
  public BITRIX24_CLIENT_ID = this.toOptionalString(
    environment.BITRIX24_CLIENT_ID
  );

  @IsOptional()
  @CannotUseWithout("BITRIX24_CLIENT_ID")
  @CannotUseWithout("BITRIX24_PORTAL_URL")
  public BITRIX24_CLIENT_SECRET = this.toOptionalString(
    environment.BITRIX24_CLIENT_SECRET
  );

  /**
   * Base URL of the Bitrix24 portal, e.g. `https://qwer.bitrix24.ru`.
   * Used both as authorize host and to resolve `/rest/user.current`.
   */
  @IsOptional()
  @CannotUseWithout("BITRIX24_CLIENT_ID")
  @IsUrl({
    require_tld: true,
    require_protocol: true,
    protocols: ["http", "https"],
  })
  public BITRIX24_PORTAL_URL = this.toOptionalString(
    environment.BITRIX24_PORTAL_URL
  );

  /**
   * Bitrix24 *incoming* webhook base URL, e.g.
   * `https://qwer.bitrix24.ru/rest/1/xxxxxxxxxxxx/`. This is a service
   * credential bound to a portal user that lets Outline call Bitrix24 REST
   * server-to-server without a per-user OAuth token — used to deliver
   * mention notifications into Bitrix24 messenger. Optional; when unset the
   * notification bridge is disabled.
   */
  @IsOptional()
  @IsUrl({
    require_tld: true,
    require_protocol: true,
    protocols: ["http", "https"],
  })
  public BITRIX24_WEBHOOK_URL = this.toOptionalString(
    environment.BITRIX24_WEBHOOK_URL
  );

  /**
   * Shared secret (`application_token`) of the Bitrix24 *outbound* event
   * handler that POSTs entity-change events to `/api/bitrix24.webhooks`.
   * Used to authenticate those inbound requests so we can invalidate stale
   * unfurl cards. Optional; when unset the inbound webhook is rejected.
   */
  @IsOptional()
  public BITRIX24_WEBHOOK_TOKEN = this.toOptionalString(
    environment.BITRIX24_WEBHOOK_TOKEN
  );
}

export default new Bitrix24PluginEnvironment();
