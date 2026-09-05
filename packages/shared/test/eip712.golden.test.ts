import { concatHex, domainSeparator, hashTypedData, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildDomain,
  computeReceiptHash,
  RIGHTS_RECEIPT_TYPE,
  RIGHTS_RECEIPT_TYPEHASH,
  type RightsReceipt,
  receiptTypedData,
} from "../src/eip712";
import { GOLDEN_RECEIPT, REGISTRY } from "./fixtures";

/**
 * GOLDEN VALUES - pinned. The Solidity side (apps/contracts/test/ReceiptLib.golden.t.sol)
 * asserts the same receiptHash for the same fixture (R-6, constitution IV/V).
 */
const GOLDEN_TYPEHASH =
  "0xd4aaed81b9c5f7040cca0726ae0a2c44640db626d394ef0d61351e1a90ee8ac4";
const GOLDEN_RECEIPT_HASH =
  "0xc7f47a15158690ea6f43dd75a98b825cb606352a1d6e137f3641ff4556681a52";

describe("EIP-712 RightsReceipt golden", () => {
  it("should encode the 17-field type string exactly as the spec", () => {
    expect(RIGHTS_RECEIPT_TYPE).toBe(
      "RightsReceipt(uint256 chainId,address verifyingContract,address nftContract,uint256 tokenId,bytes32 resourceHash,bytes32 policyHash,uint256 licenseEpoch,uint256 ownerEpochAtIssue,address licensee,uint8 permittedAction,uint8 transferMode,uint32 maxUses,uint64 expiresAt,bytes32 purchaseRequestHash,bytes32 paymentId,bytes32 nonce,uint64 issuedAt)",
    );
    expect(RIGHTS_RECEIPT_TYPEHASH).toBe(GOLDEN_TYPEHASH);
  });

  it("should produce the pinned receiptHash for the golden fixture", () => {
    expect(computeReceiptHash(GOLDEN_RECEIPT)).toBe(GOLDEN_RECEIPT_HASH);
  });

  it("should match viem's independent EIP-712 implementation (digest = 0x1901 || domainSep || hashStruct)", () => {
    const domain = buildDomain(REGISTRY);
    const viemDigest = hashTypedData(receiptTypedData(domain, GOLDEN_RECEIPT));
    const ours = keccak256(
      concatHex([
        "0x1901",
        domainSeparator({ domain }),
        computeReceiptHash(GOLDEN_RECEIPT),
      ]),
    );
    expect(ours).toBe(viemDigest);
  });

  it("should change the hash when any one of the 17 fields changes", () => {
    const base = computeReceiptHash(GOLDEN_RECEIPT);
    const other32 = `0x${"09".repeat(32)}` as const;
    const otherAddress = "0x4444444444444444444444444444444444444444" as const;
    const variants: Array<[keyof RightsReceipt, Partial<RightsReceipt>]> = [
      ["chainId", { chainId: 295n }],
      ["verifyingContract", { verifyingContract: otherAddress }],
      ["nftContract", { nftContract: otherAddress }],
      ["tokenId", { tokenId: 2n }],
      ["resourceHash", { resourceHash: other32 }],
      ["policyHash", { policyHash: other32 }],
      ["licenseEpoch", { licenseEpoch: 2n }],
      ["ownerEpochAtIssue", { ownerEpochAtIssue: 2n }],
      ["licensee", { licensee: otherAddress }],
      ["permittedAction", { permittedAction: 7 }],
      ["transferMode", { transferMode: 1 }],
      ["maxUses", { maxUses: 6 }],
      ["expiresAt", { expiresAt: GOLDEN_RECEIPT.expiresAt + 1n }],
      ["purchaseRequestHash", { purchaseRequestHash: other32 }],
      ["paymentId", { paymentId: other32 }],
      ["nonce", { nonce: other32 }],
      ["issuedAt", { issuedAt: GOLDEN_RECEIPT.issuedAt + 1n }],
    ];
    expect(variants).toHaveLength(17);
    for (const [field, patch] of variants) {
      expect(
        computeReceiptHash({ ...GOLDEN_RECEIPT, ...patch }),
        field,
      ).not.toBe(base);
    }
  });
});
