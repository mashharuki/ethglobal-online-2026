import { hashTypedData } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildDomain,
  ownerAuthTypedData,
  REVOCATION_ACTION_BUMP_LICENSE_EPOCH,
  revocationTypedData,
} from "../src/eip712";
import { ASSET_ID, NONCE, REGISTRY } from "./fixtures";

describe("challenge typed data separation", () => {
  it("should never let an access signature double as a revocation (distinct structs)", () => {
    const domain = buildDomain(REGISTRY);
    const common = {
      nonce: NONCE,
      chainId: 296n,
      tokenId: 1n,
      assetId: ASSET_ID,
      expiresAt: 1_800_000_120n,
    };
    const access = hashTypedData(ownerAuthTypedData(domain, common));
    const revocation = hashTypedData(
      revocationTypedData(domain, {
        ...common,
        action: REVOCATION_ACTION_BUMP_LICENSE_EPOCH,
      }),
    );
    expect(access).not.toBe(revocation);
  });
});
