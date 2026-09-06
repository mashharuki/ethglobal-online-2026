import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * MCP client side of the verification harness (tasks.md T120, mcp-tools.md): connects to the
 * gateway's `/mcp` (Streamable HTTP), requires the session id the gateway mints on
 * `initialize` (it is what binds `decrypt_content` to the `buy_access` of the same session,
 * R-9a), checks the three tools are advertised, and wraps them in typed calls whose results
 * are validated field by field. Tool failures come back as `McpToolError` carrying the
 * gateway's ErrorCode.
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

export type PurchasedAccess = {
  receiptHash: Hex;
  receipt: Record<string, unknown>;
  serverSignature: Hex;
  onchainTx: string;
  maxUses: number;
  expiresAt: number;
};

export type DecryptedDataset = {
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
  /** the `Mcp-Session-Id` the gateway minted on initialize (present, or connect() failed) */
  sessionId: string;
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
const TX_REF = /^0x[0-9a-fA-F]{64}$|^\d+\.\d+\.\d+[@-]\d+(\.\d+)?$/; // EVM hash or Hedera tx id

type Rec = Record<string, unknown>;

function record(tool: string, value: unknown): Rec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpToolError(tool, "MALFORMED_RESULT", "not an object");
  }
  return value as Rec;
}

function field(
  tool: string,
  rec: Rec,
  key: string,
  test: (v: unknown) => boolean,
): unknown {
  const value = rec[key];
  if (!test(value))
    throw new McpToolError(
      tool,
      "MALFORMED_RESULT",
      `${key} is missing or invalid`,
    );
  return value;
}

const isHex32 = (v: unknown): boolean => typeof v === "string" && HEX32.test(v);
const isTxRef = (v: unknown): boolean =>
  typeof v === "string" && TX_REF.test(v);
const isNonNegInt = (v: unknown): boolean =>
  Number.isInteger(v) && (v as number) >= 0;

/** Validates every field the harness (and its live assertions) relies on. */
export function validatePurchase(value: unknown): PurchasedAccess {
  const tool = "buy_access";
  const rec = record(tool, value);
  return {
    receiptHash: field(tool, rec, "receiptHash", isHex32) as Hex,
    receipt: record(tool, rec.receipt),
    serverSignature: field(
      tool,
      rec,
      "serverSignature",
      (v) => typeof v === "string" && /^0x[0-9a-fA-F]{130}$/.test(v),
    ) as Hex,
    onchainTx: field(tool, rec, "onchainTx", isTxRef) as string,
    maxUses: field(
      tool,
      rec,
      "maxUses",
      (v) => Number.isInteger(v) && (v as number) >= 1,
    ) as number,
    expiresAt: field(tool, rec, "expiresAt", isNonNegInt) as number,
  };
}

export function validateDecrypted(value: unknown): DecryptedDataset {
  const tool = "decrypt_content";
  const rec = record(tool, value);
  const dataset = record(tool, rec.dataset);
  const format = field(
    tool,
    dataset,
    "format",
    (v) => v === "json" || v === "csv" || v === "text" || v === "base64",
  ) as DecryptedDataset["dataset"]["format"];
  const content = field(
    tool,
    dataset,
    "content",
    (v) => typeof v === "string" && v !== "",
  ) as string;
  return {
    useIndex: field(tool, rec, "useIndex", isNonNegInt) as number,
    onchainTx: field(tool, rec, "onchainTx", isTxRef) as string,
    dataset: { format, content },
  };
}

function validateAssets(value: unknown): DiscoveredAsset[] {
  const tool = "discover_assets";
  if (!Array.isArray(value))
    throw new McpToolError(tool, "MALFORMED_RESULT", "not an array");
  return value.map((item) => {
    const rec = record(tool, item);
    const paid = record(tool, rec.paidAccess);
    return {
      ...(rec as Partial<DiscoveredAsset>),
      assetId: field(tool, rec, "assetId", isHex32) as Hex,
      tokenId: field(
        tool,
        rec,
        "tokenId",
        (v) => typeof v === "string" && /^\d+$/.test(v),
      ) as string,
      paidAccess: {
        price: field(
          tool,
          paid,
          "price",
          (v) => typeof v === "string" && /^\d+$/.test(v),
        ) as string,
        durationSec: field(tool, paid, "durationSec", isNonNegInt) as number,
        maxUses: field(tool, paid, "maxUses", isNonNegInt) as number,
      },
      transferMode: field(
        tool,
        rec,
        "transferMode",
        (v) => v === "SURVIVE_TRANSFER" || v === "INVALIDATE_ON_TRANSFER",
      ) as DiscoveredAsset["transferMode"],
    };
  });
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
  const sessionId = transport.sessionId;
  if (sessionId === undefined || sessionId === "") {
    await client.close();
    throw new Error(
      "MCP server minted no Mcp-Session-Id on initialize: refusing to buy without a session",
    );
  }
  const advertised = (await client.listTools()).tools.map((t) => t.name);
  const missing = RIGHTS_RUNTIME_TOOLS.filter((t) => !advertised.includes(t));
  if (missing.length > 0) {
    await client.close();
    throw new Error(
      `MCP server does not expose ${missing.join(", ")} (got ${advertised.join(", ")})`,
    );
  }

  const call = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const assertSameSession = (when: string): void => {
      if (transport.sessionId !== sessionId) {
        throw new McpToolError(
          tool,
          "SESSION_CHANGED",
          `the MCP session id changed ${when} the call`,
        );
      }
    };
    assertSameSession("before");
    const result = (await client.callTool({
      name: tool,
      arguments: args,
    })) as ToolResult;
    // a server that swapped the session on this very response is not the session that bought
    assertSameSession("during");
    return parseToolResult<unknown>(tool, result);
  };

  return {
    sessionId,
    discoverAssets: async () =>
      validateAssets(await call("discover_assets", {})),
    buyAccess: async (assetId) =>
      validatePurchase(await call("buy_access", { assetId })),
    decryptContent: async (assetId, receiptHash) =>
      validateDecrypted(
        await call("decrypt_content", { assetId, receiptHash }),
      ),
    close: () => client.close(),
  };
}
