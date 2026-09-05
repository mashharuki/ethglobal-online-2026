import type { Services } from "../services";

/** Per-request context every MCP tool runs with (built by routes/mcp.ts). */
export type McpContext = {
  services: Services;
  /** validated Mcp-Session-Id of the caller (undefined until the client echoes one) */
  sessionId: string | undefined;
};
