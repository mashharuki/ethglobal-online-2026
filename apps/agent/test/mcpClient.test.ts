import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  connectRightsRuntime,
  McpToolError,
  parseToolResult,
  RIGHTS_RUNTIME_TOOLS,
} from "../src/mcpClient";

/**
 * Client plumbing against the REAL MCP SDK server transport, in-process: session header
 * round-trip, tool-list gate, JSON / error decoding. The tools here are stand-ins for the
 * gateway (this is the harness's own unit test, not the demo path - the live gateway is
 * exercised by test/autonomous.spec.ts).
 */
const ASSET = `0x${"a1".repeat(32)}` as const;
const RECEIPT = `0x${"b2".repeat(32)}` as const;

function standInServer(
  options: { tools?: readonly string[]; failBuy?: boolean } = {},
): {
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
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify([
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
                ]),
              },
            ],
          };
        },
      );
    }
    if (tools.includes("buy_access")) {
      server.registerTool(
        "buy_access",
        { inputSchema: z.object({ assetId: z.string() }) },
        () => {
          calls.push({ tool: "buy_access", session });
          return options.failBuy
            ? {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      code: "SPEND_LIMIT_EXCEEDED",
                      message: "cap",
                    }),
                  },
                ],
              }
            : {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      receiptHash: RECEIPT,
                      receipt: {},
                      serverSignature: `0x${"11".repeat(65)}`,
                      onchainTx: "0xtx",
                      maxUses: 5,
                      expiresAt: 1,
                    }),
                  },
                ],
              };
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
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  useIndex: 0,
                  onchainTx: "0xconsume",
                  dataset: {
                    format: "csv",
                    content: "region,mrr\\nemea,10\\n",
                  },
                }),
              },
            ],
          };
        },
      );
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // the gateway mints the session on initialize; a stand-in header shows the round-trip
    if (session === null) {
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
    expect(bought.receiptHash).toBe(RECEIPT);
    const decrypted = await runtime.decryptContent(ASSET, bought.receiptHash);
    expect(decrypted.dataset.content).toContain("emea,10");
    expect(server.calls.map((c) => c.tool)).toEqual(RIGHTS_RUNTIME_TOOLS);
    expect(server.calls.every((c) => c.session === "0xsession")).toBe(true);
    await runtime.close();
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
});
