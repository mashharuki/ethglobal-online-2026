import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runAgent, writeAnswer } from "../src/index";
import { connectRightsRuntime } from "../src/mcpClient";
import { parseCheck } from "../src/verify";

/**
 * SC-007 / SC-009 (tasks.md T121): discover -> buy (real x402, native HBAR through the
 * gateway's Privy server wallet) -> decrypt (real KeyGate + consume on Hedera Testnet) ->
 * analyze (real Claude inference) -> independent verification of the answer against the
 * decrypted data, with zero human intervention. Runs only against a deployed gateway: without
 * GATEWAY_URL / ANTHROPIC_API_KEY it is SKIPPED and reported as such, never as passed.
 */
const gatewayUrl = process.env.GATEWAY_URL ?? "";
const hasApiKey = (process.env.ANTHROPIC_API_KEY ?? "") !== "";
const mirrorUrl =
  process.env.HEDERA_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com";
const ready = gatewayUrl !== "" && hasApiKey;

if (!ready) {
  const message =
    "[agent] GATEWAY_URL / ANTHROPIC_API_KEY not set: the autonomous run is SKIPPED (not verified).";
  // CI's live job sets AGENT_LIVE_REQUIRED=1: there a skip must be a failure, never a green run
  if (process.env.AGENT_LIVE_REQUIRED === "1") {
    throw new Error(`${message} AGENT_LIVE_REQUIRED=1 so this is a failure.`);
  }
  console.warn(message);
}

/** The transaction the gateway reported must exist on Hedera and have succeeded. */
async function mirrorResult(ref: string): Promise<string> {
  const path = ref.startsWith("0x")
    ? `/api/v1/contracts/results/${ref}`
    : `/api/v1/transactions/${encodeURIComponent(ref.replace("@", "-"))}`;
  const response = await fetch(`${mirrorUrl}${path}`);
  if (!response.ok) return `mirror ${response.status}`;
  const body = (await response.json()) as {
    result?: string;
    transactions?: Array<{ result?: string }>;
  };
  return body.result ?? body.transactions?.[0]?.result ?? "unknown";
}

describe.skipIf(!ready)("autonomous MCP run (SC-007 / SC-009)", () => {
  it("should discover, buy, decrypt, answer and verify without any human step", async () => {
    const check = parseCheck(process.env.AGENT_CHECK);
    const lines: string[] = [];
    const record = await runAgent({
      gatewayUrl,
      check,
      log: (line) => lines.push(line),
    });

    // one MCP session carried the purchase and the decryption (R-9a binding)
    expect(record.mcpSession).toMatch(/^0x[0-9a-f]+$/);
    // real settlement + real consume, both anchored on Hedera and both SUCCESS on the mirror node
    expect(record.receiptHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await mirrorResult(record.onchainTx.settle)).toBe("SUCCESS");
    expect(await mirrorResult(record.onchainTx.consume)).toBe("SUCCESS");
    expect(record.useIndex).toBeGreaterThanOrEqual(0);
    expect(record.dataset.chars).toBeGreaterThan(0);
    // real inference, verified by the harness itself against the decrypted data:
    // every citation a real row, the structured result == the computed row, and the verified
    // artifact is the harness statement (never the model's free text)
    expect(record.verification.ok).toBe(true);
    expect(record.verification.expected).toBeDefined();
    const expected = record.verification.expected;
    expect(record.verifiedAnswer).toBe(record.verification.statement);
    expect(record.verifiedAnswer).toContain(
      `${expected?.label}: ${expected?.value}`,
    );
    // the legs happened, in order, in one process, without any interactive step
    expect(record.steps.map((s) => s.step.split(":")[0])).toEqual([
      expect.stringMatching(/^connected/),
      "discover_assets",
      "buy_access",
      "decrypt_content",
      expect.stringMatching(/^analyze/),
      "verify",
    ]);
    expect(lines.some((l) => /prompt|confirm|press/i.test(l))).toBe(false);

    const path = writeAnswer(record);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).receiptHash).toBe(
      record.receiptHash,
    );

    // negative control (R-9a): the same receipt from a DIFFERENT MCP session is refused
    const stranger = await connectRightsRuntime(
      `${gatewayUrl.replace(/\/$/, "")}/mcp`,
    );
    try {
      expect(stranger.sessionId).not.toBe(record.mcpSession);
      await expect(
        stranger.decryptContent(record.asset.assetId, record.receiptHash),
      ).rejects.toMatchObject({
        name: "McpToolError",
        code: "MCP_SESSION_MISMATCH",
      });
    } finally {
      await stranger.close();
    }
  }, 300_000);

  it("should fail closed when the answer cannot be verified", async () => {
    // an impossible check: the dataset has no such column, so verification must throw
    await expect(
      runAgent({
        gatewayUrl,
        check: {
          labelColumn: "district",
          valueColumn: "no_such_column",
          op: "max",
        },
        log: () => {},
      }),
    ).rejects.toThrow(/no district \/ no_such_column columns|no numeric/);
  }, 300_000);
});
