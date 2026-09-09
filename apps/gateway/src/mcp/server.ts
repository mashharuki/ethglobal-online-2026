import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AppError } from "../errors";
import { AssetNotFoundError } from "../manifest/resolver";
import { hex32, jsonSafe } from "../routes/schemas";
import type { McpContext } from "./context";
import { McpToolError } from "./toolError";
import { buyAccess } from "./tools/buyAccess";
import { decryptContent } from "./tools/decryptContent";
import { discoverAssets } from "./tools/discoverAssets";
import { AgentWalletUnavailableError } from "./wallet";

/**
 * MCP server (tasks.md T096, mcp-tools.md): three tools, built fresh per request (the
 * Streamable HTTP transport is stateless on Workers; the session identity is the
 * Mcp-Session-Id header, see mcp/session.ts). Errors are MCP tool errors whose `code` is
 * either a domain ErrorCode or an McpToolErrorCode.
 */
const MCP_SERVER_INFO = {
  name: "truecollective-rights-runtime",
  version: "0.1.0",
} as const;

/**
 * OAuth scope each tool requires (undefined = unauthenticated, `discover_assets` only - it is
 * discovery-only and must keep working for callers that never went through consent).
 */
const REQUIRED_SCOPE: Record<string, string | undefined> = {
  discover_assets: undefined,
  buy_access: "access:buy",
  decrypt_content: "assets:read",
};

/**
 * Gates a tool handler on `ctx.auth` carrying the scope `toolName` needs (specs/mcp-auth-
 * remediation-plan.md §7). `MCP_AUTH_REQUIRED` (env.ts, cutover kill switch) controls how a
 * MISSING token is treated: once "true" it is a hard `AUTH_TOKEN_INVALID`; while still "false"
 * (apps/agent's CI harness does not send one yet, Phase 10) a missing token is let through
 * unchanged, exactly like before this phase. A PRESENT token is always held to its scope
 * regardless of the flag - a caller that DID authenticate gets real enforcement immediately.
 */
function withScope<TInput, TOutput>(
  toolName: string,
  fn: (ctx: McpContext, input: TInput) => Promise<TOutput>,
): (ctx: McpContext, input: TInput) => Promise<TOutput> {
  const requiredScope = REQUIRED_SCOPE[toolName];
  return async (ctx, input) => {
    if (requiredScope !== undefined) {
      if (ctx.auth === undefined) {
        if (ctx.services.env.MCP_AUTH_REQUIRED === "true") {
          throw new AppError(
            "AUTH_TOKEN_INVALID",
            `${toolName} requires a valid Bearer token`,
          );
        }
      } else if (!ctx.auth.scope.split(" ").includes(requiredScope)) {
        throw new AppError(
          "INSUFFICIENT_SCOPE",
          `${toolName} requires the "${requiredScope}" scope`,
        );
      }
    }
    return fn(ctx, input);
  };
}

function ok(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(jsonSafe(value)) }],
  };
}

function failure(error: unknown): CallToolResult {
  let code = "INTERNAL";
  let message = "unexpected error";
  if (error instanceof AppError || error instanceof McpToolError) {
    code = error.code;
    message = error.message;
  } else if (error instanceof AssetNotFoundError) {
    code = "ASSET_NOT_FOUND";
    message = `unknown asset ${error.assetId}`;
  } else if (error instanceof AgentWalletUnavailableError) {
    code = "AGENT_WALLET_UNAVAILABLE";
    message = error.message;
  } else {
    console.error("mcp tool failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ code, message }) }],
  };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return failure(error);
  }
}

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);
  server.registerTool(
    "discover_assets",
    {
      description:
        "List the assets published on the Rights Graph (discovery only - not an authorization source).",
      inputSchema: z.object({}),
    },
    () => run(() => discoverAssets(ctx)),
  );
  server.registerTool(
    "buy_access",
    {
      description:
        "Buy paid access to an asset with x402 (native HBAR on Hedera Testnet) through the agent's Privy server wallet. Returns the Rights Receipt bound to this MCP session.",
      inputSchema: z.object({ assetId: hex32 }),
    },
    ({ assetId }) =>
      run(() => withScope("buy_access", buyAccess)(ctx, { assetId })),
  );
  server.registerTool(
    "decrypt_content",
    {
      description:
        "Consume one use of a Rights Receipt bought in this MCP session and return the decrypted dataset.",
      inputSchema: z.object({ assetId: hex32, receiptHash: hex32 }),
    },
    ({ assetId, receiptHash }) =>
      run(() =>
        withScope("decrypt_content", decryptContent)(ctx, {
          assetId,
          receiptHash,
        }),
      ),
  );
  return server;
}
