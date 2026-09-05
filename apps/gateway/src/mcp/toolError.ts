/**
 * Tool-level failures that are not domain ErrorCodes (mcp-tools.md "補助コード"): the spend
 * policy, agent wallet / account readiness and content integrity. Domain rejections keep
 * their ErrorCode (AppError) so `code` in a tool error is always one of the two vocabularies.
 */
const MCP_TOOL_ERROR_CODES = [
  "SPEND_LIMIT_EXCEEDED",
  "AGENT_WALLET_UNAVAILABLE",
  "INSUFFICIENT_AGENT_BALANCE",
  "FACILITATOR_UNAVAILABLE",
  "NO_PAYMENT_OPTION",
  "CONTENT_HASH_MISMATCH",
  "INTERNAL",
] as const;
export type McpToolErrorCode = (typeof MCP_TOOL_ERROR_CODES)[number];

export class McpToolError extends Error {
  override readonly name = "McpToolError";
  constructor(
    readonly code: McpToolErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}
