import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import {
  assertSessionMatchesPrincipal,
  attemptMcpAuth,
  openAuthenticatedSession,
} from "../mcp/auth";
import { createMcpServer } from "../mcp/server";
import {
  issueSessionId,
  MCP_SESSION_HEADER,
  sessionKey,
  verifySessionId,
} from "../mcp/session";
import { type AppEnv, badRequest, notFound } from "./schemas";

/**
 * POST/GET/DELETE /mcp (tasks.md T096, openapi `mcp*`): Streamable HTTP, stateless
 * transport (one McpServer per request). The session id the tools key on is minted here on
 * `initialize` and returned as `Mcp-Session-Id`; MCP clients echo it on every later request.
 */
function isInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (m) =>
      typeof m === "object" &&
      m !== null &&
      (m as { method?: unknown }).method === "initialize",
  );
}

export function registerMcpRoutes(app: Hono<AppEnv>): void {
  app.all("/mcp", async (c) => {
    const services = c.get("services");
    if (services.env.MCP_ENABLED === "false") {
      throw notFound("MCP is disabled");
    }
    const authzDb = c.get("authzDb");
    let parsedBody: unknown;
    let initialize = false;
    if (c.req.method === "POST") {
      try {
        parsedBody = await c.req.json();
      } catch {
        throw badRequest("body must be JSON-RPC");
      }
      initialize = isInitialize(parsedBody);
    }
    const now = services.now();
    // initialize: mint a token and key the tools on its identity; later requests: the
    // identity the echoed token authenticates (undefined when absent / forged / expired)
    const token = initialize
      ? await issueSessionId(services.env, now)
      : c.req.header(MCP_SESSION_HEADER);
    const sessionId = await verifySessionId(services.env, token, now);

    // Best-effort OAuth Bearer auth (specs/mcp-auth-remediation-plan.md §7): `/mcp` never
    // hard-401s here - discover_assets must keep working with no Authorization header at all.
    // attemptMcpAuth distinguishes "no header" from "header present but invalid" (withScope,
    // mcp/server.ts, fails the latter closed regardless of the MCP_AUTH_REQUIRED flag) and
    // rethrows a genuine infra failure rather than misreporting it as an invalid credential.
    const auth = await attemptMcpAuth(
      authzDb,
      c.req.header("Authorization"),
      now,
    );
    if (sessionId !== undefined && auth.kind === "authenticated") {
      const key = sessionKey(sessionId);
      if (initialize) {
        await openAuthenticatedSession(authzDb, key, auth.principal, now);
      } else {
        // A session `initialize`d by one principal must not be usable by another just
        // because both happen to echo the same Mcp-Session-Id.
        await assertSessionMatchesPrincipal(authzDb, key, auth.principal);
      }
    }

    const server = createMcpServer({ services, sessionId, auth, authzDb });
    // Transport objects are request-local. Purchase ownership and budgets survive requests
    // through the verified session identity and database, not an in-memory MCP connection.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw, { parsedBody });
    if (!initialize || token === undefined) return response;
    const headers = new Headers(response.headers);
    headers.set("Mcp-Session-Id", token);
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  });
}
