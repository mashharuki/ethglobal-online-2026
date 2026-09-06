import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { createMcpServer } from "../mcp/server";
import {
  issueSessionId,
  MCP_SESSION_HEADER,
  verifySessionId,
} from "../mcp/session";
import { type AppEnv, badRequest } from "./schemas";

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
    const server = createMcpServer({ services, sessionId });
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
