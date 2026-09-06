import { describe, expect, it } from "vitest";
import { chooseAsset, parseArgs } from "../src/index";

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

  it("should leave absent or malformed flags undefined", () => {
    expect(parseArgs(["--verbose"])).toEqual({
      question: undefined,
      assetId: undefined,
      out: undefined,
    });
    expect(parseArgs(["--asset", "not-hex"]).assetId).toBeUndefined();
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
