import passport from "@outlinewiki/koa-passport";
import type { Context } from "koa";
import Router from "koa-router";
import { Strategy } from "passport-oauth2";
import { slugifyDomain } from "@shared/utils/domains";
import { addSeconds } from "date-fns";
import accountProvisioner from "@server/commands/accountProvisioner";
import { createContext } from "@server/context";
import passportMiddleware from "@server/middlewares/passport";
import { AuthenticationProvider, UserAuthentication } from "@server/models";
import type { User } from "@server/models";
import type { AuthenticationResult } from "@server/types";
import fetch from "@server/utils/fetch";
import {
  StateStore,
  getTeamFromContext,
  getClientFromOAuthState,
  getUserFromOAuthState,
  startOAuthFlow,
} from "@server/utils/passport";
import config from "../../plugin.json";
import env from "../env";
import {
  Bitrix24AccountInactiveError,
  Bitrix24EmailMissingError,
  Bitrix24ProfileFetchError,
} from "../errors";

const router = new Router();

interface Bitrix24User {
  ID: string | number;
  NAME?: string;
  LAST_NAME?: string;
  SECOND_NAME?: string;
  EMAIL?: string;
  PERSONAL_PHOTO?: string;
  WORK_POSITION?: string;
  ACTIVE?: boolean;
}

interface Bitrix24UserResponse {
  result?: Bitrix24User;
  error?: string;
  error_description?: string;
}

/**
 * Fetches the current Bitrix24 user via the REST `user.current` method.
 *
 * @param portalUrl base URL of the portal (no trailing slash).
 * @param accessToken OAuth access token returned by the token endpoint.
 * @returns parsed user object from the Bitrix24 REST response.
 * @throws {InvalidRequestError} when the response is malformed or contains
 *   an error payload from Bitrix24.
 */
async function fetchCurrentUser(
  portalUrl: string,
  accessToken: string
): Promise<Bitrix24User> {
  const endpoint = `${portalUrl}/rest/user.current?auth=${encodeURIComponent(
    accessToken
  )}`;
  let text: string;
  try {
    const response = await fetch(endpoint, { method: "GET" });
    text = await response.text();
  } catch (err) {
    throw Bitrix24ProfileFetchError(
      `Bitrix24 user.current request failed: ${(err as Error).message}`
    );
  }
  let json: Bitrix24UserResponse;
  try {
    json = JSON.parse(text) as Bitrix24UserResponse;
  } catch (_err) {
    throw Bitrix24ProfileFetchError(
      `Bitrix24 user.current returned non-JSON response: ${text.slice(0, 200)}`
    );
  }
  if (json.error || !json.result) {
    throw Bitrix24ProfileFetchError(
      `Bitrix24 user.current error: ${
        json.error_description || json.error || "no result"
      }`
    );
  }
  return json.result;
}

/**
 * Idempotently persist a user's Bitrix24 OAuth tokens. Runs after
 * accountProvisioner so tokens survive even the admin early-return path
 * (which skips userProvisioner). Safe on the (authenticationProviderId,
 * userId) unique constraint — updates the row in place when it exists.
 *
 * @param teamId team the user belongs to.
 * @param userId user whose tokens to store.
 * @param tokens the fresh token set from the OAuth exchange.
 */
async function persistTokens(
  teamId: string,
  userId: string,
  tokens: {
    providerId: string;
    accessToken: string;
    refreshToken: string;
    expiresIn?: number;
    scopes: string[];
  }
): Promise<void> {
  const provider = await AuthenticationProvider.findOne({
    where: { name: config.id, teamId },
  });
  if (!provider) {
    return;
  }
  const expiresAt = tokens.expiresIn
    ? addSeconds(new Date(), tokens.expiresIn)
    : null;
  const [row, created] = await UserAuthentication.findOrCreate({
    where: { userId, authenticationProviderId: provider.id },
    defaults: {
      userId,
      authenticationProviderId: provider.id,
      providerId: tokens.providerId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes,
      expiresAt,
    },
  });
  if (!created) {
    row.accessToken = tokens.accessToken;
    row.refreshToken = tokens.refreshToken;
    row.scopes = tokens.scopes;
    row.expiresAt = expiresAt;
    row.providerId = tokens.providerId;
    await row.save();
  }
}

if (
  env.BITRIX24_CLIENT_ID &&
  env.BITRIX24_CLIENT_SECRET &&
  env.BITRIX24_PORTAL_URL
) {
  const portalUrl = env.BITRIX24_PORTAL_URL.replace(/\/$/, "");
  const portalHost = new URL(portalUrl).hostname;

  passport.use(
    config.id,
    new Strategy(
      {
        clientID: env.BITRIX24_CLIENT_ID,
        clientSecret: env.BITRIX24_CLIENT_SECRET,
        passReqToCallback: true,
        // Bitrix24 scope list (per-portal local apps). We only need identity.
        scope: ["user"],
        // @ts-expect-error custom state store
        store: new StateStore(),
        state: true,
        callbackURL: `${env.URL}/auth/${config.id}.callback`,
        // Authorize through the portal so the user sees a familiar host.
        authorizationURL: `${portalUrl}/oauth/authorize/`,
        // For cloud Bitrix24 the token endpoint is centralised.
        tokenURL: "https://oauth.bitrix.info/oauth/token/",
        pkce: false,
      },
      async function (
        context: Context,
        accessToken: string,
        refreshToken: string,
        params: { expires_in?: number; scope?: string },
        _profile: unknown,
        done: (
          err: Error | null,
          user: User | null,
          result?: AuthenticationResult
        ) => void
      ) {
        try {
          const team = await getTeamFromContext(context);
          const client = getClientFromOAuthState(context);
          const stateUser =
            context.state?.auth?.user ??
            (await getUserFromOAuthState(context));

          const profile = await fetchCurrentUser(portalUrl, accessToken);

          if (profile.ACTIVE === false) {
            throw Bitrix24AccountInactiveError(
              `Bitrix24 user ${profile.ID} is deactivated on the portal`
            );
          }

          const email = profile.EMAIL?.toLowerCase();
          if (!email) {
            throw Bitrix24EmailMissingError(
              `Bitrix24 user ${profile.ID} has no email on their profile`
            );
          }

          const fullName =
            [profile.NAME, profile.LAST_NAME].filter(Boolean).join(" ").trim() ||
            email;
          const avatarUrl = profile.PERSONAL_PHOTO
            ? encodeURI(profile.PERSONAL_PHOTO)
            : undefined;
          const providerId = String(profile.ID);
          const subdomain = slugifyDomain(portalHost);

          const ctx = createContext({
            ip: context.ip,
            user: stateUser,
            authType: context.state?.auth?.type,
          });
          const result = await accountProvisioner(ctx, {
            team: {
              teamId: team?.id,
              name: "Bitrix24",
              domain: portalHost,
              subdomain,
            },
            user: {
              email,
              name: fullName,
              avatarUrl,
              // Bitrix24 portal accounts are provisioned by the workspace
              // admin, so the address is trustworthy. Without this flag
              // userProvisioner (v1.9+) rejects email-matched sign-ins with
              // InvalidAuthenticationError.
              emailVerified: true,
            },
            authenticationProvider: {
              name: config.id,
              providerId: portalHost,
            },
            authentication: {
              providerId,
              accessToken,
              refreshToken,
              expiresIn: params.expires_in,
              scopes: params.scope ? params.scope.split(" ") : ["user"],
            },
          });

          // accountProvisioner takes an early return for existing admins,
          // which skips userProvisioner and so never persists the fresh
          // tokens. Upsert them unconditionally here so re-authenticating (the
          // natural way an admin tries to fix an expired Bitrix24 connection)
          // and first-time linking from an email account both work.
          await persistTokens(result.team.id, result.user.id, {
            providerId,
            accessToken,
            refreshToken,
            expiresIn: params.expires_in,
            scopes: params.scope ? params.scope.split(" ") : ["user"],
          });

          return done(null, result.user, { ...result, client });
        } catch (err) {
          return done(err as Error, null);
        }
      }
    )
  );

  // startOAuthFlow (v1.9+) bridges a signed-in actor through the OAuth
  // round-trip when the flow starts from a custom team domain.
  router.get(config.id, startOAuthFlow, passport.authenticate(config.id));
  router.get(`${config.id}.callback`, passportMiddleware(config.id));
}

export default router;
