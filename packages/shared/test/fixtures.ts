import type { Address, Hex } from "viem";
import type { RightsReceipt } from "../src/eip712";
import { TransferMode } from "../src/hashing";
import type { RightsManifest } from "../src/manifest";

export const REGISTRY: Address = "0x1111111111111111111111111111111111111111";
export const NFT: Address = "0x2222222222222222222222222222222222222222";
export const LICENSEE: Address = "0x3333333333333333333333333333333333333333";

export const ASSET_ID: Hex = `0x${"aa".repeat(32)}`;
export const CONTENT_HASH: Hex = `0x${"bb".repeat(32)}`;
export const RESOURCE_HASH: Hex = `0x${"cc".repeat(32)}`;
export const POLICY_HASH: Hex = `0x${"dd".repeat(32)}`;
export const PURCHASE_REQUEST_HASH: Hex = `0x${"ee".repeat(32)}`;
export const PAYMENT_ID: Hex = `0x${"01".repeat(32)}`;
export const NONCE: Hex = `0x${"02".repeat(32)}`;

/**
 * Golden input shared with apps/contracts/test/ReceiptLib.golden.t.sol. Changing any
 * value here requires updating the Solidity fixture too.
 */
export const GOLDEN_RECEIPT: RightsReceipt = {
  chainId: 296n,
  verifyingContract: REGISTRY,
  nftContract: NFT,
  tokenId: 1n,
  resourceHash: RESOURCE_HASH,
  policyHash: POLICY_HASH,
  licenseEpoch: 1n,
  ownerEpochAtIssue: 1n,
  licensee: LICENSEE,
  permittedAction: 6,
  transferMode: TransferMode.SURVIVE_TRANSFER,
  maxUses: 5,
  expiresAt: 1_800_000_300n,
  purchaseRequestHash: PURCHASE_REQUEST_HASH,
  paymentId: PAYMENT_ID,
  nonce: NONCE,
  issuedAt: 1_800_000_000n,
};

export const SAMPLE_MANIFEST: RightsManifest = {
  schemaVersion: "1.0",
  assetId: ASSET_ID,
  nftContract: NFT,
  tokenId: "1",
  previewURI: "ipfs://bafypreview",
  encryptedContentURI: "ipfs://bafyciphertext",
  contentHash: CONTENT_HASH,
  keyGate: {
    scheme: "xor-2share",
    keyGateVersion: 1,
    conditionsHash: `0x${"ff".repeat(32)}`,
    ownerCondition:
      "RightsNFT.ownerOf(tokenId) == :caller && RightsNFT.accessEpoch(tokenId) == :accessEpochAtGrant",
    licenseCondition:
      "RightsRegistry.hasValidConsumption(:receiptHash, :useIndex)",
  },
  ownerAccess: { price: "0", durationSec: 3600 },
  paidAccess: { price: "5000000000000000000", durationSec: 300, maxUses: 5 },
  permissions: {
    commercialUse: false,
    aiTraining: true,
    derivativeGeneration: true,
  },
  transferMode: "SURVIVE_TRANSFER",
  revenueSplit: { creatorBps: 3000, ownerBps: 7000 },
};
