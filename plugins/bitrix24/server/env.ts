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
}

export default new Bitrix24PluginEnvironment();
