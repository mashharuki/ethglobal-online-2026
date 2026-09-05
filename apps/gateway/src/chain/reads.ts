import type { Address, Hex } from "viem";
import { rightsNftAbi, rightsRegistryAbi } from "./abi";
import type { ChainContext } from "./clients";

/**
 * eth_call wrappers over RightsNFT / RightsRegistry (tasks.md T072). These are the ONLY
 * source of authorization truth (constitution II): every KeyGate / owner / MCP decision
 * calls these at request time. Nothing here is cached; the subgraph is never consulted.
 * Pass `blockNumber` to pin several reads to one block (see readOwnerSnapshot).
 * The `@lintignore` tags mark exports whose consumers land with keygate/release and
 * ReceiptLock (tasks.md T081 / T083).
 */
type ReadOptions = { blockNumber?: bigint };

type ReceiptStatus = {
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

/** @lintignore T081/T083 */
export async function readOwnerOf(
  ctx: ChainContext,
  tokenId: bigint,
  options: ReadOptions = {},
): Promise<Address> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsNFT,
    abi: rightsNftAbi,
    functionName: "ownerOf",
    args: [tokenId],
    blockNumber: options.blockNumber,
  });
}

/** @lintignore T081/T083 */
export async function readAccessEpoch(
  ctx: ChainContext,
  tokenId: bigint,
  options: ReadOptions = {},
): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsNFT,
    abi: rightsNftAbi,
    functionName: "accessEpoch",
    args: [tokenId],
    blockNumber: options.blockNumber,
  });
}

/** @lintignore T081/T083 */
export async function readPolicyHash(
  ctx: ChainContext,
  tokenId: bigint,
  options: ReadOptions = {},
): Promise<Hex> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsNFT,
    abi: rightsNftAbi,
    functionName: "policyHash",
    args: [tokenId],
    blockNumber: options.blockNumber,
  });
}

/** @lintignore T081/T083 */
export async function readResourceHash(
  ctx: ChainContext,
  tokenId: bigint,
  options: ReadOptions = {},
): Promise<Hex> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsNFT,
    abi: rightsNftAbi,
    functionName: "resourceHash",
    args: [tokenId],
    blockNumber: options.blockNumber,
  });
}

/**
 * assetId committed at mint (immutable); the owner path derives tokenId -> assetId from
 * here (R-11). @lintignore T081/T083
 */
export async function readAssetId(
  ctx: ChainContext,
  tokenId: bigint,
  options: ReadOptions = {},
): Promise<Hex> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsNFT,
    abi: rightsNftAbi,
    functionName: "assetId",
    args: [tokenId],
    blockNumber: options.blockNumber,
  });
}

export async function readLicenseEpoch(
  ctx: ChainContext,
  tokenId: bigint,
  options: ReadOptions = {},
): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsRegistry,
    abi: rightsRegistryAbi,
    functionName: "licenseEpoch",
    args: [tokenId],
    blockNumber: options.blockNumber,
  });
}

/** @lintignore T081/T083 */
export async function readReceiptStatus(
  ctx: ChainContext,
  receiptHash: Hex,
  options: ReadOptions = {},
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
    blockNumber: options.blockNumber,
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

/**
 * Authority predicate for the licensee path (all validity branches live in the contract).
 * @lintignore T081/T083
 */
export async function readHasValidConsumption(
  ctx: ChainContext,
  receiptHash: Hex,
  useIndex: number,
  options: ReadOptions = {},
): Promise<boolean> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsRegistry,
    abi: rightsRegistryAbi,
    functionName: "hasValidConsumption",
    args: [receiptHash, useIndex],
    blockNumber: options.blockNumber,
  });
}

/** consumed[receiptHash][useIndex] - used by ReceiptLock crash recovery (R-3a). @lintignore T081/T083 */
export async function readIsConsumed(
  ctx: ChainContext,
  receiptHash: Hex,
  useIndex: number,
  options: ReadOptions = {},
): Promise<boolean> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.rightsRegistry,
    abi: rightsRegistryAbi,
    functionName: "isConsumed",
    args: [receiptHash, useIndex],
    blockNumber: options.blockNumber,
  });
}

/** Owner-path snapshot: all four reads are pinned to one block so the tuple is consistent. */
type OwnerSnapshot = {
  blockNumber: bigint;
  owner: Address;
  accessEpoch: bigint;
  policyHash: Hex;
  assetId: Hex;
};

/** @lintignore T081/T083 */
export async function readOwnerSnapshot(
  ctx: ChainContext,
  tokenId: bigint,
): Promise<OwnerSnapshot> {
  const blockNumber = await ctx.publicClient.getBlockNumber();
  const at = { blockNumber };
  const [owner, accessEpoch, policyHash, assetId] = await Promise.all([
    readOwnerOf(ctx, tokenId, at),
    readAccessEpoch(ctx, tokenId, at),
    readPolicyHash(ctx, tokenId, at),
    readAssetId(ctx, tokenId, at),
  ]);
  return { blockNumber, owner, accessEpoch, policyHash, assetId };
}
