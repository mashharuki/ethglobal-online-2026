import type { Services } from "../services";
import type { AuthAttempt } from "./auth";

/** Per-request context every MCP tool runs with (built by routes/mcp.ts). */
export type McpContext = {
  services: Services;
  /** validated Mcp-Session-Id of the caller (undefined until the client echoes one) */
  sessionId: string | undefined;
  /** Result of best-effort OAuth Bearer auth (mcp/auth.ts's `attemptMcpAuth`) - `withScope`
   * (server.ts) is what turns "failed"/"none" into a hard failure for tools that require it. */
  auth: AuthAttempt;
};
