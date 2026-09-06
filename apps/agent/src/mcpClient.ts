import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * MCP client side of the verification harness (tasks.md T120, mcp-tools.md): connects to the
 * gateway's `/mcp` (Streamable HTTP), checks the three tools are advertised, and wraps them in
 * typed calls. Tool failures come back as `McpToolError` carrying the gateway's ErrorCode.
 * The session id the gateway mints on `initialize` rides along on every later call - that is
 * what binds `decrypt_content` to the `buy_access` of the same session (R-9a).
 */
export type Hex = `0x${string}`;

export const RIGHTS_RUNTIME_TOOLS = [
  "discover_assets",
  "buy_access",
  "decrypt_content",
] as const;

export type DiscoveredAsset = {
  assetId: Hex;
  tokenId: string;
  nftContract?: Hex;
  previewURI?: string;
  manifestURI?: string;
  paidAccess: { price: string; durationSec: number; maxUses: number };
  transferMode: "SURVIVE_TRANSFER" | "INVALIDATE_ON_TRANSFER";
  permissions?: Record<string, boolean>;
};

type PurchasedAccess = {
  receiptHash: Hex;
  receipt: Record<string, unknown>;
  serverSignature: Hex;
  onchainTx: string;
  maxUses: number;
  expiresAt: number;
};

type DecryptedDataset = {
  useIndex: number;
  onchainTx: string;
  dataset: { format: "json" | "csv" | "text" | "base64"; content: string };
};

export class McpToolError extends Error {
  override readonly name = "McpToolError";
  readonly tool: string;
  readonly code: string;
  constructor(tool: string, code: string, message: string) {
    super(`${tool}: ${code} - ${message}`);
    this.tool = tool;
    this.code = code;
  }
}

export type RightsRuntimeClient = {
  /** the `Mcp-Session-Id` the gateway minted on initialize */
  sessionId: string | undefined;
  discoverAssets: () => Promise<DiscoveredAsset[]>;
  buyAccess: (assetId: Hex) => Promise<PurchasedAccess>;
  decryptContent: (assetId: Hex, receiptHash: Hex) => Promise<DecryptedDataset>;
  close: () => Promise<void>;
};

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
};

/** Text payload of a tool result, parsed as JSON (the gateway always answers JSON text). */
export function parseToolResult<T>(tool: string, result: ToolResult): T {
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (text === undefined)
    throw new McpToolError(tool, "EMPTY_RESULT", "no text content");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new McpToolError(tool, "MALFORMED_RESULT", text.slice(0, 200));
  }
  if (result.isError === true) {
    const err = (typeof body === "object" && body !== null ? body : {}) as {
      code?: unknown;
      message?: unknown;
    };
    throw new McpToolError(
      tool,
      typeof err.code === "string" ? err.code : "INTERNAL",
      typeof err.message === "string" ? err.message : text.slice(0, 200),
    );
  }
  return body as T;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function assertHex32(tool: string, field: string, value: unknown): Hex {
  if (typeof value !== "string" || !HEX32.test(value)) {
    throw new McpToolError(tool, "MALFORMED_RESULT", `${field} is not bytes32`);
  }
  return value as Hex;
}

export async function connectRightsRuntime(
  mcpUrl: string,
  options: { fetch?: typeof fetch; clientName?: string } = {},
): Promise<RightsRuntimeClient> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    fetch: options.fetch,
  });
  const client = new Client({
    name: options.clientName ?? "truecollective-agent-harness",
    version: "0.1.0",
  });
  await client.connect(transport);
  const advertised = (await client.listTools()).tools.map((t) => t.name);
  const missing = RIGHTS_RUNTIME_TOOLS.filter((t) => !advertised.includes(t));
  if (missing.length > 0) {
    await client.close();
    throw new Error(
      `MCP server does not expose ${missing.join(", ")} (got ${advertised.join(", ")})`,
    );
  }

  const call = async <T>(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<T> =>
    parseToolResult<T>(
      tool,
      (await client.callTool({ name: tool, arguments: args })) as ToolResult,
    );

  return {
    get sessionId() {
      return transport.sessionId;
    },
    discoverAssets: async () => {
      const assets = await call<DiscoveredAsset[]>("discover_assets", {});
      if (!Array.isArray(assets)) {
        throw new McpToolError(
          "discover_assets",
          "MALFORMED_RESULT",
          "not an array",
        );
      }
      return assets;
    },
    buyAccess: async (assetId) => {
      const bought = await call<PurchasedAccess>("buy_access", { assetId });
      assertHex32("buy_access", "receiptHash", bought.receiptHash);
      return bought;
    },
    decryptContent: async (assetId, receiptHash) => {
      const decrypted = await call<DecryptedDataset>("decrypt_content", {
        assetId,
        receiptHash,
      });
      if (
        typeof decrypted.dataset?.content !== "string" ||
        decrypted.dataset.content === ""
      ) {
        throw new McpToolError(
          "decrypt_content",
          "MALFORMED_RESULT",
          "empty dataset",
        );
      }
      return decrypted;
    },
    close: () => client.close(),
  };
}
