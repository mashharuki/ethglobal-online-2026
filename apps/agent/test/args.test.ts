import { describe, expect, it } from "vitest";
import {
  chooseAsset,
  parseArgs,
  VerificationError,
  writeAnswer,
} from "../src/index";

const ASSET = `0x${"a1".repeat(32)}` as const;

describe("parseArgs", () => {
  it("should read --question, a valid --asset and --out", () => {
    expect(
      parseArgs([
        "--question",
        "What is the median?",
        "--asset",
        ASSET,
        "--out",
        "x.json",
      ]),
    ).toEqual({
      question: "What is the median?",
      assetId: ASSET,
      out: "x.json",
    });
  });

  it("should leave absent flags undefined", () => {
    expect(parseArgs([])).toEqual({
      question: undefined,
      assetId: undefined,
      out: undefined,
    });
  });

  it("should reject unknown flags, equals syntax and duplicates before anything is bought", () => {
    expect(() => parseArgs(["--verbose"])).toThrow(
      /unsupported argument "--verbose"/,
    );
    expect(() => parseArgs([`--asset=${ASSET}`])).toThrow(
      /unsupported argument/,
    );
    expect(() => parseArgs(["--asset", ASSET, "--asset", ASSET])).toThrow(
      /--asset given twice/,
    );
    expect(() => parseArgs(["--question", "q", "stray"])).toThrow(
      /unsupported argument "stray"/,
    );
  });

  it("should reject a malformed --asset instead of silently buying the first asset", () => {
    expect(() => parseArgs(["--asset", "not-hex"])).toThrow(
      /--asset must be a bytes32/,
    );
    expect(() => parseArgs(["--asset"])).toThrow(/--asset needs a value/);
    expect(() => parseArgs(["--question", "--asset", ASSET])).toThrow(
      /--question needs a value/,
    );
  });
});

describe("chooseAsset", () => {
  const listed = [
    {
      assetId: `0x${"c3".repeat(32)}` as const,
      tokenId: "1",
      paidAccess: { price: "1", durationSec: 1, maxUses: 0 },
      transferMode: "SURVIVE_TRANSFER" as const,
    },
    {
      assetId: ASSET,
      tokenId: "2",
      paidAccess: { price: "1", durationSec: 1, maxUses: 5 },
      transferMode: "SURVIVE_TRANSFER" as const,
    },
  ];

  it("should pick the first purchasable asset, or the named one", () => {
    expect(chooseAsset(listed).tokenId).toBe("2");
    expect(
      chooseAsset(listed, ASSET.toUpperCase() as typeof ASSET).tokenId,
    ).toBe("2");
  });

  it("should refuse an unknown asset and an empty listing", () => {
    expect(() => chooseAsset(listed, `0x${"ff".repeat(32)}`)).toThrow(
      /not listed/,
    );
    expect(() => chooseAsset([])).toThrow(/no purchasable asset/);
  });
});

describe("success artifact", () => {
  it("should never write an unverified answer", () => {
    const record = {
      question: "q",
      gatewayUrl: "http://g",
      mcpSession: "0x1",
      asset: listedAsset(),
      receiptHash: ASSET,
      onchainTx: { settle: "0x", consume: "0x" },
      useIndex: 0,
      dataset: { format: "csv", chars: 1, truncated: false },
      model: "m",
      analysis: { answer: "a", evidence: [], confidence: "low" as const },
      verification: { ok: false, problems: ["no evidence cited"] },
      verifiedAnswer: undefined,
      steps: [],
    };
    expect(() => writeAnswer(record, "/dev/null/never.json")).toThrow(
      /unverified/,
    );
    expect(new VerificationError(record).message).toContain(
      "no evidence cited",
    );
  });
});

function listedAsset() {
  return {
    assetId: ASSET,
    tokenId: "2",
    paidAccess: { price: "1", durationSec: 1, maxUses: 5 },
    transferMode: "SURVIVE_TRANSFER" as const,
  };
}
