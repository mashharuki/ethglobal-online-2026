import { describe, expect, it } from "vitest";
import { computePolicyHash, TransferMode } from "../src/hashing";
import {
  deriveShareUInfo,
  manifestPolicyHash,
  manifestToPolicyInput,
  parseManifest,
  RightsManifestSchema,
} from "../src/manifest";
import { ASSET_ID, SAMPLE_MANIFEST } from "./fixtures";

describe("RightsManifest schema", () => {
  it("should accept the data-model.md sample", () => {
    const result = parseManifest(SAMPLE_MANIFEST);
    expect(result.ok).toBe(true);
  });

  it("should reject a revenue split that does not sum to 10000", () => {
    const result = parseManifest({
      ...SAMPLE_MANIFEST,
      revenueSplit: { creatorBps: 3000, ownerBps: 6000 },
    });
    expect(result.ok).toBe(false);
  });

  it("should reject a price below tinybar precision and a zero price", () => {
    expect(
      RightsManifestSchema.safeParse({
        ...SAMPLE_MANIFEST,
        paidAccess: {
          ...SAMPLE_MANIFEST.paidAccess,
          price: "5000000000000000001",
        },
      }).success,
    ).toBe(false);
    expect(
      RightsManifestSchema.safeParse({
        ...SAMPLE_MANIFEST,
        paidAccess: { ...SAMPLE_MANIFEST.paidAccess, price: "0" },
      }).success,
    ).toBe(false);
  });

  it("should reject maxUses above uint32, unknown transferMode and unknown keys", () => {
    expect(
      RightsManifestSchema.safeParse({
        ...SAMPLE_MANIFEST,
        paidAccess: { ...SAMPLE_MANIFEST.paidAccess, maxUses: 4_294_967_296 },
      }).success,
    ).toBe(false);
    expect(
      RightsManifestSchema.safeParse({
        ...SAMPLE_MANIFEST,
        transferMode: "BURN",
      }).success,
    ).toBe(false);
    expect(
      RightsManifestSchema.safeParse({ ...SAMPLE_MANIFEST, extra: 1 }).success,
    ).toBe(false);
  });

  it("should derive the policyHash input in tinybar and match computePolicyHash", () => {
    const input = manifestToPolicyInput(SAMPLE_MANIFEST);
    expect(input).toEqual({
      priceTinybar: 500_000_000n,
      durationSec: 300n,
      maxUses: 5,
      permittedAction: 6,
      transferMode: TransferMode.SURVIVE_TRANSFER,
      creatorBps: 3000,
      ownerBps: 7000,
    });
    expect(manifestPolicyHash(SAMPLE_MANIFEST)).toBe(computePolicyHash(input));
  });

  it("should build the HKDF info string from the lower-cased assetId", () => {
    expect(deriveShareUInfo(ASSET_ID.toUpperCase() as `0x${string}`)).toBe(
      `truenft/keygate/v1/${ASSET_ID}`,
    );
  });
});
