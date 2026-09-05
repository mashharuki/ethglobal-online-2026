import type { Address, Hex } from "viem";
import { rightsNftAbi, rightsRegistryAbi } from "./abi";
import type { ChainContext } from "./clients";

/**
 * eth_call wrappers over RightsNFT / RightsRegistry (tasks.md T072). These are the ONLY
 * source of authorization truth (constitution II): every KeyGate / owner / MCP decision
 * calls these at request time. Nothing here is cached; the subgraph is never consulted.
 */
export type ReceiptStatus = {
  issued: boolean;
  tokenId: bigint;
  licenseEpochAtIssue: bigint;
  ownerEpochAtIssue: bigint;
  licensee: Address;
  transferMode: number;
  maxUses: number;
  usedCount: number;
  expiresAt: bigint;
};

/** @lintignore consumed by keygate/release + ReceiptLock (tasks.md T081/T083, next PR) */
export async function readOwnerOf(
  ctx: ChainContext,
  tokenId: bigint,
): Promise<Address> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsNFT,
    abi: rightsNftAbi,
    functionName: "ownerOf",
    args: [tokenId],
  });
}

/** @lintignore consumed by keygate/release + ReceiptLock (tasks.md T081/T083, next PR) */
export async function readAccessEpoch(
  ctx: ChainContext,
  tokenId: bigint,
): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsNFT,
    abi: rightsNftAbi,
    functionName: "accessEpoch",
    args: [tokenId],
  });
}

/** @lintignore consumed by keygate/release + ReceiptLock (tasks.md T081/T083, next PR) */
export async function readPolicyHash(
  ctx: ChainContext,
  tokenId: bigint,
): Promise<Hex> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsNFT,
    abi: rightsNftAbi,
    functionName: "policyHash",
    args: [tokenId],
  });
}

/** @lintignore consumed by keygate/release + ReceiptLock (tasks.md T081/T083, next PR) */
export async function readResourceHash(
  ctx: ChainContext,
  tokenId: bigint,
): Promise<Hex> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsNFT,
    abi: rightsNftAbi,
    functionName: "resourceHash",
    args: [tokenId],
  });
}

/** assetId committed at mint (immutable); the owner path derives tokenId -> assetId from here (R-11). @lintignore consumed by keygate/release + ReceiptLock (tasks.md T081/T083, next PR) */
export async function readAssetId(
  ctx: ChainContext,
  tokenId: bigint,
): Promise<Hex> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsNFT,
    abi: rightsNftAbi,
    functionName: "assetId",
    args: [tokenId],
  });
}

export async function readLicenseEpoch(
  ctx: ChainContext,
  tokenId: bigint,
): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsRegistry,
    abi: rightsRegistryAbi,
    functionName: "licenseEpoch",
    args: [tokenId],
  });
}

/** @lintignore consumed by keygate/release + ReceiptLock (tasks.md T081/T083, next PR) */
export async function readReceiptStatus(
  ctx: ChainContext,
  receiptHash: Hex,
): Promise<ReceiptStatus> {
  const [
    issued,
    tokenId,
    licenseEpochAtIssue,
    ownerEpochAtIssue,
    licensee,
    transferMode,
    maxUses,
    usedCount,
    expiresAt,
  ] = await ctx.publicClient.readContract({
    address: ctx.deployment.rightsRegistry,
    abi: rightsRegistryAbi,
    functionName: "receiptStatus",
    args: [receiptHash],
  });
  return {
    issued,
    tokenId,
    licenseEpochAtIssue,
    ownerEpochAtIssue,
    licensee,
    transferMode,
    maxUses,
    usedCount,
    expiresAt,
  };
}

/** Authority predicate for the licensee path (all validity branches live in the contract). @lintignore consumed by keygate/release + ReceiptLock (tasks.md T081/T083, next PR) */
export async function readHasValidConsumption(
  ctx: ChainContext,
  receiptHash: Hex,
  useIndex: number,
): Promise<boolean> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsRegistry,
    abi: rightsRegistryAbi,
    functionName: "hasValidConsumption",
    args: [receiptHash, useIndex],
  });
}

/** consumed[receiptHash][useIndex] - used by ReceiptLock crash recovery (R-3a). @lintignore consumed by keygate/release + ReceiptLock (tasks.md T081/T083, next PR) */
export async function readIsConsumed(
  ctx: ChainContext,
  receiptHash: Hex,
  useIndex: number,
): Promise<boolean> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsRegistry,
    abi: rightsRegistryAbi,
    functionName: "isConsumed",
    args: [receiptHash, useIndex],
  });
}

/** Owner-path snapshot read at request time (ownerOf + accessEpoch + policyHash + assetId). */
export type OwnerSnapshot = {
  owner: Address;
  accessEpoch: bigint;
  policyHash: Hex;
  assetId: Hex;
};

/** @lintignore consumed by keygate/release + ReceiptLock (tasks.md T081/T083, next PR) */
export async function readOwnerSnapshot(
  ctx: ChainContext,
  tokenId: bigint,
): Promise<OwnerSnapshot> {
  const [owner, accessEpoch, policyHash, assetId] = await Promise.all([
    readOwnerOf(ctx, tokenId),
    readAccessEpoch(ctx, tokenId),
    readPolicyHash(ctx, tokenId),
    readAssetId(ctx, tokenId),
  ]);
  return { owner, accessEpoch, policyHash, assetId };
}
