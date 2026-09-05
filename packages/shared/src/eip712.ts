import {
  type Address,
  encodeAbiParameters,
  type Hex,
  keccak256,
  stringToHex,
} from "viem";
import type { TransferModeValue } from "./hashing";

/**
 * EIP-712 typed data (contracts/eip712-types.md). This file is the single TypeScript
 * implementation; Solidity `ReceiptLib` re-implements `hashStruct` and the golden test
 * asserts both sides produce the same `receiptHash`.
 */

export const HEDERA_TESTNET_CHAIN_ID = 296;
export const EIP712_DOMAIN_NAME = "TrueCollective";
export const EIP712_DOMAIN_VERSION = "1";

export type TrueCollectiveDomain = {
  name: typeof EIP712_DOMAIN_NAME;
  version: typeof EIP712_DOMAIN_VERSION;
  chainId: number;
  verifyingContract: Address;
};

export function buildDomain(
  verifyingContract: Address,
  chainId: number = HEDERA_TESTNET_CHAIN_ID,
): TrueCollectiveDomain {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}

/** Type definitions in the shape viem's `signTypedData` / `verifyTypedData` expect. */
export const TYPED_DATA_TYPES = {
  RightsReceipt: [
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "nftContract", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "resourceHash", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "licenseEpoch", type: "uint256" },
    { name: "ownerEpochAtIssue", type: "uint256" },
    { name: "licensee", type: "address" },
    { name: "permittedAction", type: "uint8" },
    { name: "transferMode", type: "uint8" },
    { name: "maxUses", type: "uint32" },
    { name: "expiresAt", type: "uint64" },
    { name: "purchaseRequestHash", type: "bytes32" },
    { name: "paymentId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
  KeyGateChallenge: [
    { name: "assetId", type: "bytes32" },
    { name: "purpose", type: "string" },
    { name: "receiptHash", type: "bytes32" },
  ],
  OwnerAuthChallenge: [
    { name: "nonce", type: "bytes32" },
    { name: "chainId", type: "uint256" },
    { name: "tokenId", type: "uint256" },
    { name: "assetId", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
  ],
  LicenseeAuthChallenge: [
    { name: "nonce", type: "bytes32" },
    { name: "chainId", type: "uint256" },
    { name: "receiptHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export type RightsReceipt = {
  chainId: bigint;
  verifyingContract: Address;
  nftContract: Address;
  tokenId: bigint;
  resourceHash: Hex;
  policyHash: Hex;
  licenseEpoch: bigint;
  ownerEpochAtIssue: bigint;
  licensee: Address;
  permittedAction: number;
  transferMode: TransferModeValue;
  maxUses: number;
  expiresAt: bigint;
  purchaseRequestHash: Hex;
  paymentId: Hex;
  nonce: Hex;
  issuedAt: bigint;
};

export type KeyGateChallenge = {
  assetId: Hex;
  purpose: "owner" | "licensee";
  receiptHash: Hex;
};

export type OwnerAuthChallenge = {
  nonce: Hex;
  chainId: bigint;
  tokenId: bigint;
  assetId: Hex;
  expiresAt: bigint;
};

export type LicenseeAuthChallenge = {
  nonce: Hex;
  chainId: bigint;
  receiptHash: Hex;
  expiresAt: bigint;
};

function encodeType(primaryType: keyof typeof TYPED_DATA_TYPES): string {
  const fields = TYPED_DATA_TYPES[primaryType]
    .map((f) => `${f.type} ${f.name}`)
    .join(",");
  return `${primaryType}(${fields})`;
}

export const RIGHTS_RECEIPT_TYPE = encodeType("RightsReceipt");
/** keccak256("RightsReceipt(uint256 chainId,...,uint64 issuedAt)") - must equal Solidity RIGHTS_RECEIPT_TYPEHASH */
export const RIGHTS_RECEIPT_TYPEHASH: Hex = keccak256(
  stringToHex(RIGHTS_RECEIPT_TYPE),
);

/**
 * EIP-712 hashStruct(RightsReceipt) = keccak256(abi.encode(TYPEHASH, field1..field17)).
 * All 17 fields are static types so no nested encoding is needed. This value is the
 * on-chain authorization key (`receiptHash`).
 */
export function computeReceiptHash(receipt: RightsReceipt): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint8" },
        { type: "uint8" },
        { type: "uint32" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint64" },
      ],
      [
        RIGHTS_RECEIPT_TYPEHASH,
        receipt.chainId,
        receipt.verifyingContract,
        receipt.nftContract,
        receipt.tokenId,
        receipt.resourceHash,
        receipt.policyHash,
        receipt.licenseEpoch,
        receipt.ownerEpochAtIssue,
        receipt.licensee,
        receipt.permittedAction,
        receipt.transferMode,
        receipt.maxUses,
        receipt.expiresAt,
        receipt.purchaseRequestHash,
        receipt.paymentId,
        receipt.nonce,
        receipt.issuedAt,
      ],
    ),
  );
}

/** Domain-bound typed data for signing / verifying a Rights Receipt (server signature). */
export function receiptTypedData(
  domain: TrueCollectiveDomain,
  receipt: RightsReceipt,
) {
  return {
    domain,
    types: { RightsReceipt: TYPED_DATA_TYPES.RightsReceipt },
    primaryType: "RightsReceipt",
    message: receipt,
  } as const;
}

export function ownerAuthTypedData(
  domain: TrueCollectiveDomain,
  message: OwnerAuthChallenge,
) {
  return {
    domain,
    types: { OwnerAuthChallenge: TYPED_DATA_TYPES.OwnerAuthChallenge },
    primaryType: "OwnerAuthChallenge",
    message,
  } as const;
}

export function licenseeAuthTypedData(
  domain: TrueCollectiveDomain,
  message: LicenseeAuthChallenge,
) {
  return {
    domain,
    types: { LicenseeAuthChallenge: TYPED_DATA_TYPES.LicenseeAuthChallenge },
    primaryType: "LicenseeAuthChallenge",
    message,
  } as const;
}

export function keyGateTypedData(
  domain: TrueCollectiveDomain,
  message: KeyGateChallenge,
) {
  return {
    domain,
    types: { KeyGateChallenge: TYPED_DATA_TYPES.KeyGateChallenge },
    primaryType: "KeyGateChallenge",
    message,
  } as const;
}
