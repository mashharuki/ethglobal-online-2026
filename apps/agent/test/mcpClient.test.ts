import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  connectRightsRuntime,
  McpToolError,
  parseToolResult,
  RIGHTS_RUNTIME_TOOLS,
  validateDecrypted,
  validatePurchase,
} from "../src/mcpClient";

/**
 * Client plumbing against the REAL MCP SDK server transport, in-process: session header
 * round-trip, tool-list gate, JSON / error decoding, field validation. The tools here are
 * stand-ins for the gateway (this is the harness's own unit test, not the demo path - the
 * live gateway, including the cross-session refusal, is exercised by test/autonomous.spec.ts).
 */
const ASSET = `0x${"a1".repeat(32)}` as const;
const RECEIPT = `0x${"b2".repeat(32)}` as const;
const TX = `0x${"c3".repeat(32)}`;
const SIG = `0x${"11".repeat(65)}`;

type Options = {
  tools?: readonly string[];
  failBuy?: boolean;
  noSession?: boolean;
  purchase?: Record<string, unknown>;
};

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

function standInServer(options: Options = {}): {
  fetch: typeof fetch;
  calls: Array<{ tool: string; session: string | null }>;
} {
  const calls: Array<{ tool: string; session: string | null }> = [];
  const tools = options.tools ?? RIGHTS_RUNTIME_TOOLS;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const server = new McpServer({ name: "stand-in", version: "0.0.0" });
    const session = request.headers.get("mcp-session-id");
    if (tools.includes("discover_assets")) {
      server.registerTool(
        "discover_assets",
        { inputSchema: z.object({}) },
        () => {
          calls.push({ tool: "discover_assets", session });
          return text([
            {
              assetId: ASSET,
              tokenId: "1",
              paidAccess: {
                price: "5000000000000000000",
                durationSec: 300,
                maxUses: 5,
              },
              transferMode: "SURVIVE_TRANSFER",
            },
          ]);
        },
      );
    }
    if (tools.includes("buy_access")) {
      server.registerTool(
        "buy_access",
        { inputSchema: z.object({ assetId: z.string() }) },
        () => {
          calls.push({ tool: "buy_access", session });
          if (options.failBuy) {
            return {
              isError: true,
              ...text({ code: "SPEND_LIMIT_EXCEEDED", message: "cap" }),
            };
          }
          return text(
            options.purchase ?? {
              receiptHash: RECEIPT,
              receipt: {},
              serverSignature: SIG,
              onchainTx: TX,
              maxUses: 5,
              expiresAt: 1,
            },
          );
        },
      );
    }
    if (tools.includes("decrypt_content")) {
      server.registerTool(
        "decrypt_content",
        {
          inputSchema: z.object({
            assetId: z.string(),
            receiptHash: z.string(),
          }),
        },
        () => {
          calls.push({ tool: "decrypt_content", session });
          return text({
            useIndex: 0,
            onchainTx: "0.0.1234@1757000000.000000001",
            dataset: { format: "csv", content: "region,mrr\nemea,10\n" },
          });
        },
      );
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // the gateway mints the session on initialize; the stand-in shows the round-trip
    if (session === null && !options.noSession) {
      const headers = new Headers(response.headers);
      headers.set("mcp-session-id", "0xsession");
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  };
  return { fetch: fetchImpl, calls };
}

describe("mcpClient (T120)", () => {
  it("should run discover -> buy -> decrypt with the minted session id on every call", async () => {
    const server = standInServer();
    const runtime = await connectRightsRuntime("http://gateway.test/mcp", {
      fetch: server.fetch,
    });
    expect(runtime.sessionId).toBe("0xsession");
    const assets = await runtime.discoverAssets();
    expect(assets[0]?.assetId).toBe(ASSET);
    const bought = await runtime.buyAccess(ASSET);
    expect(bought).toMatchObject({
      receiptHash: RECEIPT,
      onchainTx: TX,
      maxUses: 5,
    });
    const decrypted = await runtime.decryptContent(ASSET, bought.receiptHash);
    expect(decrypted.dataset.content).toContain("emea,10");
    expect(server.calls.map((c) => c.tool)).toEqual(RIGHTS_RUNTIME_TOOLS);
    expect(server.calls.every((c) => c.session === "0xsession")).toBe(true);
    await runtime.close();
  });

  it("should refuse to proceed when initialize mints no session id", async () => {
    const server = standInServer({ noSession: true });
    await expect(
      connectRightsRuntime("http://gateway.test/mcp", { fetch: server.fetch }),
    ).rejects.toThrow(/minted no Mcp-Session-Id/);
    expect(server.calls).toEqual([]); // nothing was bought
  });

  it("should surface a tool error as McpToolError with the gateway code", async () => {
    const server = standInServer({ failBuy: true });
    const runtime = await connectRightsRuntime("http://gateway.test/mcp", {
      fetch: server.fetch,
    });
    await expect(runtime.buyAccess(ASSET)).rejects.toMatchObject({
      name: "McpToolError",
      tool: "buy_access",
      code: "SPEND_LIMIT_EXCEEDED",
    });
    await runtime.close();
  });

  it("should reject a purchase result that lacks the on-chain transaction", async () => {
    const server = standInServer({
      purchase: {
        receiptHash: RECEIPT,
        receipt: {},
        serverSignature: SIG,
        maxUses: 5,
        expiresAt: 1,
      },
    });
    const runtime = await connectRightsRuntime("http://gateway.test/mcp", {
      fetch: server.fetch,
    });
    await expect(runtime.buyAccess(ASSET)).rejects.toThrow(
      /onchainTx is missing or invalid/,
    );
    await runtime.close();
  });

  it("should refuse a server that does not expose the three tools", async () => {
    const server = standInServer({ tools: ["discover_assets"] });
    await expect(
      connectRightsRuntime("http://gateway.test/mcp", { fetch: server.fetch }),
    ).rejects.toThrow(/does not expose buy_access, decrypt_content/);
  });

  it("should decode results strictly", () => {
    expect(
      parseToolResult("t", { content: [{ type: "text", text: '{"a":1}' }] }),
    ).toEqual({ a: 1 });
    expect(() => parseToolResult("t", { content: [] })).toThrow(McpToolError);
    expect(() =>
      parseToolResult("t", { content: [{ type: "text", text: "nope" }] }),
    ).toThrow(/MALFORMED_RESULT/);
    expect(() =>
      parseToolResult("t", {
        isError: true,
        content: [{ type: "text", text: '{"code":"X"}' }],
      }),
    ).toThrow(/X/);
  });

  it("should validate every field the harness relies on", () => {
    const good = {
      receiptHash: RECEIPT,
      receipt: {},
      serverSignature: SIG,
      onchainTx: TX,
      maxUses: 1,
      expiresAt: 0,
    };
    expect(validatePurchase(good)).toEqual(good);
    expect(() => validatePurchase({ ...good, receiptHash: "0x12" })).toThrow(
      /receiptHash/,
    );
    expect(() => validatePurchase({ ...good, onchainTx: "pending" })).toThrow(
      /onchainTx/,
    );
    expect(() => validatePurchase({ ...good, maxUses: 0 })).toThrow(/maxUses/);
    expect(() => validatePurchase("nope")).toThrow(/not an object/);
    const decrypted = {
      useIndex: 2,
      onchainTx: TX,
      dataset: { format: "json", content: "{}" },
    };
    expect(validateDecrypted(decrypted)).toEqual(decrypted);
    expect(() =>
      validateDecrypted({
        ...decrypted,
        dataset: { format: "json", content: "" },
      }),
    ).toThrow(/content/);
    expect(() => validateDecrypted({ ...decrypted, useIndex: -1 })).toThrow(
      /useIndex/,
    );
  });
});
