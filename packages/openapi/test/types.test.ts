import { describe, expect, it } from "vitest";
import type { ErrorBody, JsonResponse, Schemas } from "../src/index";

describe("@truenft/openapi generated types", () => {
  it("should type the /healthz response from openapi.yaml", () => {
    const health: JsonResponse<"/healthz", "get"> = { ok: true, chainId: 296 };
    expect(health.chainId).toBe(296);
  });

  it("should constrain error bodies to the ErrorCode enum", () => {
    const body: ErrorBody = {
      code: "OWNER_EPOCH_MISMATCH",
      message: "This session predates an NFT transfer.",
    };
    expect(body.code).toBe("OWNER_EPOCH_MISMATCH");
  });

  it("should type the x402 402 payload and the settle response", () => {
    const required: JsonResponse<"/assets/{assetId}/paid", "get", 402> = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "hedera:testnet",
          asset: "native",
          maxAmountRequired: "5000000000000000000",
          payTo: "0x1111111111111111111111111111111111111111",
          resource: "/assets/0xaa/paid",
          extra: { settlementMode: "primary" },
        },
      ],
    };
    expect(required.accepts[0]?.network).toBe("hedera:testnet");

    const receipt: Schemas["RightsReceipt"] = {
      chainId: 296,
      verifyingContract: "0x1111111111111111111111111111111111111111",
      nftContract: "0x2222222222222222222222222222222222222222",
      tokenId: "1",
      resourceHash: `0x${"cc".repeat(32)}`,
      policyHash: `0x${"dd".repeat(32)}`,
      licenseEpoch: "0",
      ownerEpochAtIssue: "1",
      licensee: "0x3333333333333333333333333333333333333333",
      permittedAction: 6,
      transferMode: 0,
      maxUses: 5,
      expiresAt: 1_800_000_300,
      purchaseRequestHash: `0x${"ee".repeat(32)}`,
      paymentId: `0x${"01".repeat(32)}`,
      nonce: `0x${"02".repeat(32)}`,
      issuedAt: 1_800_000_000,
    };
    const settled: JsonResponse<"/assets/{assetId}/paid", "post"> = {
      receiptHash: `0x${"ab".repeat(32)}`,
      receipt,
      serverSignature: "0x",
      onchainTx: "0x",
      maxUses: 5,
      expiresAt: 1_800_000_300,
    };
    expect(Object.keys(settled.receipt)).toHaveLength(17);
  });

  it("should discriminate keygate share requests by path", () => {
    const licensee: Schemas["KeygateShareRequest"] = {
      path: "licensee",
      assetId: `0x${"aa".repeat(32)}`,
      receiptHash: `0x${"ab".repeat(32)}`,
      authSig: "0x",
    };
    expect(licensee.path).toBe("licensee");
  });
});
