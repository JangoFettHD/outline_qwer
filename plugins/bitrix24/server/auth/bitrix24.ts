import passport from "@outlinewiki/koa-passport";
import type { Context } from "koa";
import Router from "koa-router";
import { Strategy } from "passport-oauth2";
import { slugifyDomain } from "@shared/utils/domains";
import accountProvisioner from "@server/commands/accountProvisioner";
import { createContext } from "@server/context";
import { InvalidRequestError } from "@server/errors";
import passportMiddleware from "@server/middlewares/passport";
import type { User } from "@server/models";
import type { AuthenticationResult } from "@server/types";
import fetch from "@server/utils/fetch";
import {
  StateStore,
  getTeamFromContext,
  getClientFromOAuthState,
  getUserFromOAuthState,
} from "@server/utils/passport";
import config from "../../plugin.json";
import env from "../env";

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
  const response = await fetch(endpoint, { method: "GET" });
  const text = await response.text();
  let json: Bitrix24UserResponse;
  try {
    json = JSON.parse(text) as Bitrix24UserResponse;
  } catch (_err) {
    throw InvalidRequestError(
      `Bitrix24 user.current returned non-JSON response: ${text.slice(0, 200)}`
    );
  }
  if (json.error || !json.result) {
    throw InvalidRequestError(
      `Bitrix24 user.current error: ${
        json.error_description || json.error || "no result"
      }`
    );
  }
  return json.result;
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

          const email = profile.EMAIL?.toLowerCase();
          if (!email) {
            throw InvalidRequestError(
              "Email is missing on the Bitrix24 profile. Fill it in your Bitrix24 user profile and try again."
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

          return done(null, result.user, { ...result, client });
        } catch (err) {
          return done(err as Error, null);
        }
      }
    )
  );

  router.get(config.id, passport.authenticate(config.id));
  router.get(`${config.id}.callback`, passportMiddleware(config.id));
}

export default router;
