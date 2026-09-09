import type { Hono } from "hono";
import { z } from "zod";
import { beginAuthorization } from "../oauth/authorize";
import { registerClient } from "../oauth/clients";
import { revokeToken } from "../oauth/revoke";
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  type TokenResult,
} from "../oauth/token";
import type { AppEnv } from "./schemas";
import { badRequest, parseBody } from "./schemas";

/**
 * OAuth 2.1 authorization-server flow endpoints (specs/mcp-auth-remediation-plan.md §6).
 * /token and /revoke are form-urlencoded per RFC 6749/RFC 7009 (not this codebase's usual
 * JSON `parseBody`) - every standard OAuth client library sends these as
 * application/x-www-form-urlencoded, so accepting only JSON here would make this server
 * incompatible with all of them. /oauth/consent (verifies the user's Privy identity,
 * provisions the AI wallet, creates the grant) is NOT in this PR - it needs its own design
 * pass together with the Phase 9 web consent UI it's called from, tracked as a follow-up.
 */
const RegisterBody = z.object({
  // client_name is OPTIONAL per RFC 7591 §2 - clients.ts falls back to a display name when
  // it's omitted, rather than rejecting the request.
  client_name: z.string().optional(),
  redirect_uris: z.array(z.string()).min(1),
  scope: z.string().optional(),
});

export function registerOauthRoutes(app: Hono<AppEnv>): void {
  app.post("/oauth/register", async (c) => {
    const body = await parseBody(c, RegisterBody);
    const client = await registerClient(c.get("authzDb"), {
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
      scope: body.scope,
    });
    // RFC 7591 §3.2.1 response shape - client_secret is deliberately omitted (this codebase
    // only ever issues "none"-auth public clients).
    return c.json(
      {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        ...(client.scope !== null ? { scope: client.scope } : {}),
      },
      201,
    );
  });

  app.get("/oauth/authorize", async (c) => {
    const query = AuthorizeQuery.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!query.success) {
      throw badRequest("invalid authorization request", query.error.issues);
    }
    const origin = new URL(c.req.url).origin;
    const outcome = await beginAuthorization(
      c.get("authzDb"),
      origin,
      {
        clientId: query.data.client_id,
        redirectUri: query.data.redirect_uri,
        scope: query.data.scope,
        resource: query.data.resource,
        codeChallenge: query.data.code_challenge,
        codeChallengeMethod: query.data.code_challenge_method,
        state: query.data.state ?? null,
      },
      new Date(),
    );
    if (outcome.kind === "redirect_to_consent") {
      const target = new URL("/ai-consent", c.env.WEB_APP_URL);
      target.searchParams.set("request_id", outcome.requestId);
      return c.redirect(target.toString(), 302);
    }
    const target = new URL(outcome.redirectUri);
    target.searchParams.set("error", outcome.error);
    target.searchParams.set("error_description", outcome.errorDescription);
    if (outcome.state !== null) target.searchParams.set("state", outcome.state);
    return c.redirect(target.toString(), 302);
  });

  app.post("/oauth/token", async (c) => {
    const raw = await c.req.parseBody();
    const body = TokenBody.safeParse(raw);
    if (!body.success) {
      return tokenErrorResponse({
        ok: false,
        status: 400,
        error: "invalid_request",
        errorDescription: "malformed token request",
      });
    }
    let result: TokenResult;
    if (body.data.grant_type === "authorization_code") {
      result = await exchangeAuthorizationCode(
        c.get("authzDb"),
        {
          code: body.data.code,
          redirectUri: body.data.redirect_uri,
          clientId: body.data.client_id,
          codeVerifier: body.data.code_verifier,
        },
        new Date(),
      );
    } else {
      result = await refreshAccessToken(
        c.get("authzDb"),
        {
          refreshToken: body.data.refresh_token,
          clientId: body.data.client_id,
        },
        new Date(),
      );
    }
    return tokenErrorResponse(result);
  });

  app.post("/oauth/revoke", async (c) => {
    const raw = await c.req.parseBody();
    const body = RevokeBody.safeParse(raw);
    if (!body.success) {
      throw badRequest("invalid revocation request", body.error.issues);
    }
    await revokeToken(c.get("authzDb"), body.data.token, new Date());
    // RFC 7009 §2.2: always 200, whether or not the token existed.
    return c.body(null, 200);
  });
}

function tokenErrorResponse(result: TokenResult) {
  if (result.ok) {
    return Response.json({
      access_token: result.accessToken,
      token_type: "Bearer",
      expires_in: result.expiresIn,
      refresh_token: result.refreshToken,
      scope: result.scope,
    });
  }
  return Response.json(
    { error: result.error, error_description: result.errorDescription },
    { status: result.status },
  );
}

const AuthorizeQuery = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  scope: z.string().min(1),
  resource: z.string().min(1),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string().min(1),
  state: z.string().optional(),
});

const TokenBody = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(1),
    redirect_uri: z.string().min(1),
    client_id: z.string().min(1),
    code_verifier: z.string().min(1),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(1),
    client_id: z.string().min(1),
  }),
]);

const RevokeBody = z.object({
  token: z.string().min(1),
  token_type_hint: z.string().optional(),
});
