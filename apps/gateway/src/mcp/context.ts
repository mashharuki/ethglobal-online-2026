import type { Services } from "../services";
import type { McpPrincipal } from "./auth";

/** Per-request context every MCP tool runs with (built by routes/mcp.ts). */
export type McpContext = {
  services: Services;
  /** validated Mcp-Session-Id of the caller (undefined until the client echoes one) */
  sessionId: string | undefined;
  /** OAuth Bearer-derived identity of the caller (undefined when absent/invalid - `withScope`
   * in server.ts is what turns that into a hard failure for tools that require it). */
  auth: McpPrincipal | undefined;
};
