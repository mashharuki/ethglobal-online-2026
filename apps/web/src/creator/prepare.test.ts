import { manifestPolicyHash, parseManifest } from "@truenft/shared";
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { buildManifest, hbarToWeibar, type ManifestDraft } from "./prepare";

const draft: ManifestDraft = {
  chainId: 296,
  nftContract: "0x1111111111111111111111111111111111111111",
  rightsRegistry: "0x2222222222222222222222222222222222222222",
  name: "dataset-1",
  previewURI: "https://example.invalid/preview.png",
  encryptedContentURI: "ipfs://bafyencrypted",
  contentHash: keccak256(new Uint8Array([1, 2, 3])),
  priceHbar: "5",
  durationSec: 300,
  maxUses: 5,
  transferMode: "SURVIVE_TRANSFER",
  permissions: {
    commercialUse: true,
    aiTraining: false,
    derivativeGeneration: true,
  },
  creatorBps: 3000,
};

describe("creator console (T110)", () => {
  it("should convert HBAR to weibar at tinybar precision", () => {
    expect(hbarToWeibar("5")).toBe("5000000000000000000");
    expect(hbarToWeibar("0.00000001")).toBe("10000000000");
    expect(() => hbarToWeibar("1.123456789")).toThrow("8 decimals");
    expect(() => hbarToWeibar("abc")).toThrow();
  });

  it("should build a manifest that validates and hashes consistently", () => {
    const built = buildManifest(draft, "7");
    expect(parseManifest(built.manifest).ok).toBe(true);
    expect(built.manifest.tokenId).toBe("7");
    expect(built.manifest.revenueSplit).toEqual({
      creatorBps: 3000,
      ownerBps: 7000,
    });
    expect(built.policyHash).toBe(manifestPolicyHash(built.manifest));
    expect(built.assetId).toMatch(/^0x[0-9a-f]{64}$/);
    // the assetId is stable for the same name + content, the tokenId does not change it
    expect(buildManifest(draft, "8").assetId).toBe(built.assetId);
  });

  it("should reject an invalid policy before anything is minted", () => {
    expect(() => buildManifest({ ...draft, maxUses: 0 }, "1")).toThrow(
      "manifest invalid",
    );
    expect(() =>
      buildManifest({ ...draft, creatorBps: 20_000 }, "1"),
    ).toThrow();
  });
});
