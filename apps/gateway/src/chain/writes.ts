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
 * Transaction submission for RightsRegistry (tasks.md T073). Submission (simulate + send,
 * returns the tx hash) is separated from confirmation (`waitForTx`) so OperatorTxQueue can
 * persist the hash before waiting and never double-submits after a crash (R-3a). The
 * `send*` helpers compose both for callers that do not need that split. Nonce assignment
 * is left to the caller; pass `nonce` to pin it. `@lintignore` marks exports whose
 * consumer is the x402 facilitator / settlement route (tasks.md T084 / T088).
 */
/** @lintignore T084/T088 */
export type ReceiptParams = ContractFunctionArgs<
  typeof rightsRegistryAbi,
  "payable",
  "settleAndIssue"
>[0];

export type WriteContext = ChainContext & { wallet: OperatorWallet };

type TxResult = { txHash: Hex; receipt: TransactionReceipt };

type WriteOptions = { nonce?: number };

/** @lintignore T084/T088 */
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

function rethrow(error: unknown): never {
  const mapped = revertToAppError(error);
  if (mapped !== undefined) throw mapped;
  throw error;
}

/**
 * Waits for one confirmation of an already-submitted tx. Throws TxRevertedError (with the
 * hash) if it mined with status 0.
 */
export async function waitForTx(
  ctx: ChainContext,
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

/** `consume(receiptHash, useIndex)` - operator only (R-3a). Returns the tx hash. */
export async function submitConsume(
  ctx: WriteContext,
  receiptHash: Hex,
  useIndex: number,
  options: WriteOptions = {},
): Promise<Hex> {
  try {
    const { request } = await ctx.publicClient.simulateContract({
      account: ctx.wallet.account,
      address: ctx.deployment.rightsRegistry,
      abi: rightsRegistryAbi,
      functionName: "consume",
      args: [receiptHash, useIndex],
    });
    return await ctx.wallet.writeContract({
      ...request,
      nonce: options.nonce,
    });
  } catch (error) {
    rethrow(error);
  }
}

/** @lintignore T084/T088 */
export async function sendConsume(
  ctx: WriteContext,
  receiptHash: Hex,
  useIndex: number,
  options: WriteOptions = {},
): Promise<TxResult> {
  const txHash = await submitConsume(ctx, receiptHash, useIndex, options);
  return waitForTx(ctx, txHash, "consume");
}

/**
 * `settleAndIssue(p)` with exact native value (weibar = price tinybar * 1e10). Returns the
 * tx hash and the receiptHash the simulation produced. @lintignore T084/T088
 */
export async function submitSettleAndIssue(
  ctx: WriteContext,
  params: ReceiptParams,
  valueWeibar: bigint,
  options: WriteOptions = {},
): Promise<{ txHash: Hex; receiptHash: Hex }> {
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
    return { txHash, receiptHash: result };
  } catch (error) {
    rethrow(error);
  }
}

/** @lintignore T084/T088 */
export async function sendSettleAndIssue(
  ctx: WriteContext,
  params: ReceiptParams,
  valueWeibar: bigint,
  options: WriteOptions = {},
): Promise<TxResult & { receiptHash: Hex }> {
  const { txHash, receiptHash } = await submitSettleAndIssue(
    ctx,
    params,
    valueWeibar,
    options,
  );
  const settled = await waitForTx(ctx, txHash, "settleAndIssue");
  return { ...settled, receiptHash };
}

/** `bumpLicenseEpoch(tokenId)` - emergency revocation / policy update path. */
export async function submitBumpLicenseEpoch(
  ctx: WriteContext,
  tokenId: bigint,
  options: WriteOptions = {},
): Promise<Hex> {
  try {
    const { request } = await ctx.publicClient.simulateContract({
      account: ctx.wallet.account,
      address: ctx.deployment.rightsRegistry,
      abi: rightsRegistryAbi,
      functionName: "bumpLicenseEpoch",
      args: [tokenId],
    });
    return await ctx.wallet.writeContract({
      ...request,
      nonce: options.nonce,
    });
  } catch (error) {
    rethrow(error);
  }
}

/** @lintignore T084/T088 */
export async function sendBumpLicenseEpoch(
  ctx: WriteContext,
  tokenId: bigint,
  options: WriteOptions = {},
): Promise<TxResult> {
  const txHash = await submitBumpLicenseEpoch(ctx, tokenId, options);
  return waitForTx(ctx, txHash, "bumpLicenseEpoch");
}
