import type { Hono } from "hono";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from "../oauth/metadata";
import type { AppEnv } from "./schemas";

/**
 * OAuth discovery documents (RFC 9728 / RFC 8414, specs/mcp-auth-remediation-plan.md §6).
 * Static, unauthenticated GETs - the `.well-known` paths are fixed by the RFCs, not something
 * a client can vary.
 */
export function registerWellKnownRoutes(app: Hono<AppEnv>): void {
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(buildProtectedResourceMetadata(origin));
  });

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(buildAuthorizationServerMetadata(origin));
  });
}
