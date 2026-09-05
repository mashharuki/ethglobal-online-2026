import { SOLIDITY_ERROR_TO_CODE } from "@truenft/shared";
import {
  BaseError,
  type ContractFunctionArgs,
  ContractFunctionRevertedError,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { AppError } from "../errors";
import { rightsRegistryAbi } from "./abi";
import type { ChainContext, OperatorWallet } from "./clients";

/**
 * Transaction submission for RightsRegistry (tasks.md T073): simulate -> write -> wait,
 * with revert reasons mapped to the public ErrorCode. Nonce assignment is left to the
 * caller (OperatorTxQueue serializes it, R-3a); pass `nonce` to pin it.
 */
export type ReceiptParams = ContractFunctionArgs<
  typeof rightsRegistryAbi,
  "payable",
  "settleAndIssue"
>[0];

export type WriteContext = ChainContext & { wallet: OperatorWallet };

export type TxResult = { txHash: Hex; receipt: TransactionReceipt };

/** @lintignore consumed by keygate/release + ReceiptLock (tasks.md T081/T083, next PR) */
export class TxRevertedError extends Error {
  override readonly name = "TxRevertedError";
  constructor(
    readonly txHash: Hex,
    readonly functionName: string,
  ) {
    super(`${functionName} reverted on-chain (tx ${txHash})`);
  }
}

/**
 * viem wraps a custom-error revert in ContractFunctionRevertedError inside a BaseError chain.
 * Returns the mapped AppError, or undefined when the error is not a known custom error
 * (caller rethrows the original so operational failures are not disguised as user errors).
 */
export function revertToAppError(error: unknown): AppError | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk(
    (e) => e instanceof ContractFunctionRevertedError,
  );
  if (!(reverted instanceof ContractFunctionRevertedError)) return undefined;
  const errorName = reverted.data?.errorName;
  if (errorName === undefined) return undefined;
  const code = SOLIDITY_ERROR_TO_CODE[errorName];
  if (code === undefined) return undefined;
  return new AppError(code, undefined, { solidityError: errorName });
}

async function waitFor(
  ctx: WriteContext,
  txHash: Hex,
  functionName: string,
): Promise<TxResult> {
  const receipt = await ctx.publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });
  if (receipt.status !== "success") {
    throw new TxRevertedError(txHash, functionName);
  }
  return { txHash, receipt };
}

function rethrow(error: unknown): never {
  const mapped = revertToAppError(error);
  if (mapped !== undefined) throw mapped;
  throw error;
}

export type WriteOptions = { nonce?: number };

/** `consume(receiptHash, useIndex)` - operator only (R-3a). @lintignore consumed by keygate/release + ReceiptLock (tasks.md T081/T083, next PR) */
export async function sendConsume(
  ctx: WriteContext,
  receiptHash: Hex,
  useIndex: number,
  options: WriteOptions = {},
): Promise<TxResult> {
  try {
    const { request } = await ctx.publicClient.simulateContract({
      account: ctx.wallet.account,
      address: ctx.deployment.rightsRegistry,
      abi: rightsRegistryAbi,
      functionName: "consume",
      args: [receiptHash, useIndex],
    });
    const txHash = await ctx.wallet.writeContract({
      ...request,
      nonce: options.nonce,
    });
    return await waitFor(ctx, txHash, "consume");
  } catch (error) {
    rethrow(error);
  }
}

/** `settleAndIssue(p)` with exact native value (weibar = price tinybar * 1e10). @lintignore consumed by keygate/release + ReceiptLock (tasks.md T081/T083, next PR) */
export async function sendSettleAndIssue(
  ctx: WriteContext,
  params: ReceiptParams,
  valueWeibar: bigint,
  options: WriteOptions = {},
): Promise<TxResult & { receiptHash: Hex }> {
  try {
    const { request, result } = await ctx.publicClient.simulateContract({
      account: ctx.wallet.account,
      address: ctx.deployment.rightsRegistry,
      abi: rightsRegistryAbi,
      functionName: "settleAndIssue",
      args: [params],
      value: valueWeibar,
    });
    const txHash = await ctx.wallet.writeContract({
      ...request,
      nonce: options.nonce,
    });
    const settled = await waitFor(ctx, txHash, "settleAndIssue");
    return { ...settled, receiptHash: result };
  } catch (error) {
    rethrow(error);
  }
}

/** `bumpLicenseEpoch(tokenId)` - emergency revocation / policy update path. @lintignore consumed by keygate/release + ReceiptLock (tasks.md T081/T083, next PR) */
export async function sendBumpLicenseEpoch(
  ctx: WriteContext,
  tokenId: bigint,
  options: WriteOptions = {},
): Promise<TxResult> {
  try {
    const { request } = await ctx.publicClient.simulateContract({
      account: ctx.wallet.account,
      address: ctx.deployment.rightsRegistry,
      abi: rightsRegistryAbi,
      functionName: "bumpLicenseEpoch",
      args: [tokenId],
    });
    const txHash = await ctx.wallet.writeContract({
      ...request,
      nonce: options.nonce,
    });
    return await waitFor(ctx, txHash, "bumpLicenseEpoch");
  } catch (error) {
    rethrow(error);
  }
}
