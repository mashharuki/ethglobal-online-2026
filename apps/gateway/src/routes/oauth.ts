import type { Hono } from "hono";
import { z } from "zod";
import { registerClient } from "../oauth/clients";
import type { AppEnv } from "./schemas";
import { parseBody } from "./schemas";

/**
 * OAuth 2.1 authorization-server flow endpoints (specs/mcp-auth-remediation-plan.md §6).
 * Only RFC 7591 dynamic client registration lands in this PR - /authorize, /token, /revoke
 * are a follow-up (they depend on grant.ts/spend.ts's delegation+budget primitives, already
 * merged, but need their own dedicated review given the security surface).
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
}
