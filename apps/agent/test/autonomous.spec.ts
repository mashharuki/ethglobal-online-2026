import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runAgent, writeAnswer } from "../src/index";

/**
 * SC-007 / SC-009 (tasks.md T121): discover -> buy (real x402, native HBAR through the
 * gateway's Privy server wallet) -> decrypt (real KeyGate + consume on Hedera Testnet) ->
 * analyze (real Claude inference), with zero human intervention. Runs only against a deployed
 * gateway: without GATEWAY_URL / ANTHROPIC_API_KEY it is SKIPPED and reported as such, never
 * as passed.
 */
const gatewayUrl = process.env.GATEWAY_URL ?? "";
const hasApiKey = (process.env.ANTHROPIC_API_KEY ?? "") !== "";
const ready = gatewayUrl !== "" && hasApiKey;

if (!ready) {
  console.warn(
    "[agent] GATEWAY_URL / ANTHROPIC_API_KEY not set: the autonomous run is SKIPPED (not verified).",
  );
}

describe.skipIf(!ready)("autonomous MCP run (SC-007 / SC-009)", () => {
  it("should discover, buy, decrypt and answer without any human step", async () => {
    const question =
      process.env.AGENT_QUESTION ??
      "Which segment grew the most? Answer with the figures from the dataset.";
    const lines: string[] = [];
    const record = await runAgent({
      question,
      gatewayUrl,
      log: (line) => lines.push(line),
    });

    // one MCP session carried the purchase and the decryption (R-9a binding)
    expect(record.mcpSession).toMatch(/^0x[0-9a-f]+$/);
    // real settlement + real consume, both anchored on Hedera
    expect(record.receiptHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(record.onchainTx.settle).not.toBe("");
    expect(record.onchainTx.consume).not.toBe("");
    expect(record.useIndex).toBeGreaterThanOrEqual(0);
    expect(record.dataset.chars).toBeGreaterThan(0);
    // real inference: an answer grounded in the decrypted data, every citation verbatim
    expect(record.analysis.answer.trim()).not.toBe("");
    expect(record.analysis.evidence.length).toBeGreaterThan(0);
    expect(
      record.ungroundedEvidence,
      "evidence not found in the dataset",
    ).toEqual([]);
    // the four legs happened, in order, in one process
    expect(record.steps.map((s) => s.step.split(":")[0])).toEqual([
      expect.stringMatching(/^connected/),
      "discover_assets",
      "buy_access",
      "decrypt_content",
      expect.stringMatching(/^analyze/),
    ]);
    expect(lines.some((l) => /prompt|confirm|press/i.test(l))).toBe(false);

    const path = writeAnswer(record);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).receiptHash).toBe(
      record.receiptHash,
    );
  }, 300_000);
});
