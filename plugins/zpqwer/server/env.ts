import { IsOptional, IsUrl } from "class-validator";
import { Environment } from "@server/env";
import environment from "@server/utils/environment";
import { CannotUseWithout } from "@server/utils/validators";

class ZpqwerPluginEnvironment extends Environment {
  /**
   * Base URL of the agency staff portal, e.g. `https://my.qwer.agency`.
   * The read-only card/search API lives under `${BASE}/api/ext/v1`.
   */
  @IsOptional()
  @CannotUseWithout("ZPQWER_API_KEY")
  @IsUrl({
    require_tld: true,
    require_protocol: true,
    protocols: ["http", "https"],
  })
  public ZPQWER_BASE_URL = this.toOptionalString(environment.ZPQWER_BASE_URL);

  /**
   * Shared service key for the portal's external read API, sent as the
   * `X-ZPQWER-Key` header. The portal additionally restricts calls to an IP
   * allowlist, so this key alone is not sufficient to read anything.
   */
  @IsOptional()
  @CannotUseWithout("ZPQWER_BASE_URL")
  public ZPQWER_API_KEY = this.toOptionalString(environment.ZPQWER_API_KEY);
}

export default new ZpqwerPluginEnvironment();
