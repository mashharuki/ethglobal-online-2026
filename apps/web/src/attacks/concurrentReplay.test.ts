import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { createApi } from "../api/client";
import { runConcurrentReplay, summarizeOutcomes } from "./concurrentReplay";

const ASSET_ID = `0x${"a5".repeat(32)}` as Hex;
const RECEIPT = `0x${"d4".repeat(32)}` as Hex;
const WALLET = "0x1111111111111111111111111111111111111111" as const;

describe("concurrent replay (T109 / SC-005)", () => {
  it("should count settled vs rejected by code", () => {
    expect(
      summarizeOutcomes([
        { ok: true, useIndex: 0 },
        { ok: false, code: "RECEIPT_ALREADY_CONSUMED" },
        { ok: false, code: "RECEIPT_ALREADY_CONSUMED" },
        { ok: false, code: "USE_LIMIT_EXCEEDED" },
      ]),
    ).toEqual({
      total: 4,
      settled: 1,
      rejected: 3,
      codes: { RECEIPT_ALREADY_CONSUMED: 2, USE_LIMIT_EXCEEDED: 1 },
    });
  });

  it("should sign one fresh challenge per request and fire them together", async () => {
    let challenges = 0;
    let shares = 0;
    const api = createApi("http://gateway.test", async (input, init) => {
      const req = new Request(input, init);
      const url = req.url;
      if (url.endsWith("/keygate/challenge")) {
        challenges += 1;
        return Response.json({
          typedData: {
            domain: {},
            types: {},
            primaryType: "X",
            message: { n: challenges },
          },
          nonce: `0x${challenges.toString(16).padStart(64, "0")}`,
          expiresAt: 1,
        });
      }
      shares += 1;
      const body = (await req.json()) as { authSig: string };
      // the gateway settles exactly one; the rest are rejected as already consumed
      return body.authSig.endsWith("01")
        ? Response.json({
            path: "licensee",
            shareG: "0x",
            blindedU: "0x",
            useIndex: 0,
            onchainTx: "0x",
            encryptedContentURI: "",
            contentHash: "0x",
          })
        : Response.json(
            { code: "RECEIPT_ALREADY_CONSUMED", message: "" },
            { status: 409 },
          );
    });
    const outcomes = await runConcurrentReplay({
      api,
      signers: {
        signTypedData: async (td) =>
          `0x${String((td.message as { n: number }).n).padStart(2, "0")}` as Hex,
        signRawHash: async () => "0x",
      },
      wallet: WALLET,
      assetId: ASSET_ID,
      receiptHash: RECEIPT,
      parallelism: 5,
    });
    expect(challenges).toBe(5);
    expect(shares).toBe(5);
    expect(summarizeOutcomes(outcomes)).toMatchObject({
      settled: 1,
      rejected: 4,
    });
  });
});
