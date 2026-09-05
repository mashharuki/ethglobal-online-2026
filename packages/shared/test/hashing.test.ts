import { describe, expect, it } from "vitest";
import {
  bitflagsToPermissions,
  canonicalPath,
  computeConditionsHash,
  computePolicyHash,
  computePurchaseRequestHash,
  computeResourceHash,
  conditionSelector,
  permissionsToBitflags,
  TransferMode,
  tinybarToWeibar,
  WEIBAR_PER_HBAR,
  weibarToTinybar,
} from "../src/hashing";
import {
  ASSET_ID,
  CONTENT_HASH,
  NFT,
  POLICY_HASH,
  REGISTRY,
  RESOURCE_HASH,
} from "./fixtures";

describe("canonicalPath", () => {
  it("should lower-case, strip trailing slashes and sort query keys", () => {
    expect(canonicalPath("/Assets/ABC/Paid/?z=1&a=2")).toBe(
      "/assets/abc/paid?a=2&z=1",
    );
  });
  it("should keep the root path and drop fragments", () => {
    expect(canonicalPath("/")).toBe("/");
    expect(canonicalPath("/assets/1#frag")).toBe("/assets/1");
    expect(canonicalPath("assets/1")).toBe("/assets/1");
  });
  it("should be idempotent", () => {
    const once = canonicalPath("/A/B/?q=2&p=1");
    expect(canonicalPath(once)).toBe(once);
  });
});

describe("HBAR unit conversion (R-4)", () => {
  it("should convert whole HBAR between weibar and tinybar", () => {
    expect(weibarToTinybar(5n * WEIBAR_PER_HBAR)).toBe(500_000_000n);
    expect(tinybarToWeibar(500_000_000n)).toBe(5n * WEIBAR_PER_HBAR);
  });
  it("should reject weibar amounts below tinybar precision", () => {
    expect(() => weibarToTinybar(10_000_000_001n)).toThrow(RangeError);
    expect(() => weibarToTinybar(-1n)).toThrow(RangeError);
  });
});

describe("permission bit flags", () => {
  it("should round-trip the three permissions", () => {
    const perms = {
      commercialUse: false,
      aiTraining: true,
      derivativeGeneration: true,
    };
    expect(permissionsToBitflags(perms)).toBe(6);
    expect(bitflagsToPermissions(6)).toEqual(perms);
    expect(
      permissionsToBitflags({
        commercialUse: true,
        aiTraining: false,
        derivativeGeneration: false,
      }),
    ).toBe(1);
  });
});

describe("resourceHash / policyHash / conditionsHash / purchaseRequestHash", () => {
  it("should be deterministic and sensitive to every input", () => {
    const base = {
      nftContract: NFT,
      tokenId: 1n,
      assetId: ASSET_ID,
      contentHash: CONTENT_HASH,
    };
    const h = computeResourceHash(base);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeResourceHash(base)).toBe(h);
    expect(computeResourceHash({ ...base, tokenId: 2n })).not.toBe(h);
    expect(
      computeResourceHash({ ...base, contentHash: `0x${"00".repeat(32)}` }),
    ).not.toBe(h);
  });

  it("should derive policyHash from tinybar price and change with any policy field", () => {
    const base = {
      priceTinybar: 500_000_000n,
      durationSec: 300n,
      maxUses: 5,
      permittedAction: 6,
      transferMode: TransferMode.SURVIVE_TRANSFER,
      creatorBps: 3000,
      ownerBps: 7000,
    };
    const h = computePolicyHash(base);
    expect(computePolicyHash({ ...base, priceTinybar: 1n })).not.toBe(h);
    expect(computePolicyHash({ ...base, maxUses: 4_294_967_295 })).not.toBe(h);
    expect(
      computePolicyHash({
        ...base,
        transferMode: TransferMode.INVALIDATE_ON_TRANSFER,
      }),
    ).not.toBe(h);
    expect(
      computePolicyHash({ ...base, creatorBps: 2999, ownerBps: 7001 }),
    ).not.toBe(h);
  });

  it("should derive 4-byte condition selectors and a conditionsHash bound to the registry", () => {
    expect(
      conditionSelector(
        "RightsRegistry.hasValidConsumption(:receiptHash, :useIndex)",
      ),
    ).toMatch(/^0x[0-9a-f]{8}$/);
    const input = {
      ownerCondition: "owner",
      licenseCondition: "license",
      verifyingContract: REGISTRY,
    };
    const h = computeConditionsHash(input);
    expect(
      computeConditionsHash({ ...input, verifyingContract: NFT }),
    ).not.toBe(h);
    expect(
      computeConditionsHash({ ...input, licenseCondition: "license2" }),
    ).not.toBe(h);
  });

  it("should bind purchaseRequestHash to method/path/plan/resource/policy but never to a body", () => {
    const input = {
      httpMethod: "post",
      path: "/Assets/1/Paid/",
      planId: `0x${"05".repeat(32)}` as const,
      resourceHash: RESOURCE_HASH,
      policyHash: POLICY_HASH,
    };
    const h = computePurchaseRequestHash(input);
    expect(
      computePurchaseRequestHash({
        ...input,
        httpMethod: "POST",
        path: "/assets/1/paid",
      }),
    ).toBe(h);
    expect(
      computePurchaseRequestHash({ ...input, httpMethod: "GET" }),
    ).not.toBe(h);
    expect(
      computePurchaseRequestHash({ ...input, path: "/assets/2/paid" }),
    ).not.toBe(h);
    expect(
      computePurchaseRequestHash({ ...input, policyHash: RESOURCE_HASH }),
    ).not.toBe(h);
  });
});
