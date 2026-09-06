import type { Address, Hex } from "viem";
import { AppError } from "../errors";

/**
 * OperatorTxQueue state machine (tasks.md T083, research.md R-3a problem 4). A single
 * instance serialises every transaction the operator key sends so two ReceiptLocks (different
 * receipts) can never race on the nonce.
 *
 * Every job carries a mandatory idempotency key (ReceiptLock: receipt + useIndex + attempt;
 * settlement: paymentId; revocation route: token + challenge nonce) and a durable job record:
 * - the nonce is RESERVED (nonce + 1 saved, job record written) BEFORE the broadcast, so a
 *   crash between broadcast and return never lets another job reuse it
 * - a retried job whose record has a tx hash gets that hash back (no second broadcast)
 * - a retried job whose record has NO hash is in unknown broadcast state: the nonce is
 *   re-synchronised from the chain's pending count (which already includes a broadcast that
 *   did happen) before it is broadcast again
 * - after any failure the stored nonce is cleared so the next job re-syncs from the chain
 *   instead of trusting a counter that may or may not have been consumed
 * - "nonce too low / already known" rejections re-sync once and retry
 * - bumpLicenseEpoch carries the epoch it was decided against (`fromEpoch`); if the chain
 *   already moved past it the job is refused (LICENSE_EPOCH_MISMATCH) instead of bumping
 *   twice - a duplicate bump would revoke receipts issued in between
 *
 * Residual window: a crash after broadcast but before the hash was recorded means the retry
 * is broadcast again at a fresh nonce; a duplicate `consume` reverts harmlessly
 * (ReceiptAlreadyConsumed -> ReceiptLock recovery), a duplicate bump is blocked by fromEpoch,
 * a duplicate settleAndIssue / finalize reverts with ReceiptAlreadyIssued (same paymentId).
 */
/** ReceiptParams (18 fields) as decimal strings / hex - JSON-safe across the DO boundary. */
export type ReceiptParamsJson = {
  nftContract: Address;
  tokenId: string;
  resourceHash: Hex;
  policyHash: Hex;
  licenseEpoch: string;
  ownerEpochAtIssue: string;
  licensee: Address;
  permittedAction: number;
  transferMode: number;
  maxUses: number;
  expiresAt: string;
  purchaseRequestHash: Hex;
  paymentId: Hex;
  nonce: Hex;
  issuedAt: string;
  price: string;
  creatorBps: number;
  ownerBps: number;
};

export type OperatorJob = (
  | { kind: "consume"; receiptHash: Hex; useIndex: number }
  | { kind: "bumpLicenseEpoch"; tokenId: bigint; fromEpoch: bigint }
  | { kind: "settleAndIssue"; params: ReceiptParamsJson; valueWeibar: string }
  | { kind: "finalize"; paymentId: Hex; params: ReceiptParamsJson }
) & {
  /** stable identity of this logical attempt; enables the tx-hash replay on retries */
  idempotencyKey: string;
};

export type JobRecord = { nonce: number; txHash?: Hex; failed?: boolean };

export type QueuePorts = {
  /** eth_getTransactionCount(operator, "pending") */
  getPendingNonce(): Promise<number>;
  loadNonce(): Promise<number | undefined>;
  saveNonce(nonce: number): Promise<void>;
  clearNonce(): Promise<void>;
  loadJob(key: string): Promise<JobRecord | undefined>;
  saveJob(key: string, record: JobRecord): Promise<void>;
  /** RightsRegistry.licenseEpoch(tokenId) - duplicate-bump guard */
  readLicenseEpoch(tokenId: bigint): Promise<bigint>;
  /** simulate + send; resolves to the tx hash, throws the mapped AppError on revert */
  submit(job: OperatorJob, nonce: number): Promise<Hex>;
};

const NONCE_ERROR_RE = /nonce/i;

export function isNonceError(error: unknown): boolean {
  return error instanceof Error && NONCE_ERROR_RE.test(error.message);
}

export class OperatorQueueCore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly ports: QueuePorts) {}

  enqueue(job: OperatorJob): Promise<Hex> {
    const run = this.tail.then(
      () => this.run(job),
      () => this.run(job),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async run(job: OperatorJob): Promise<Hex> {
    const key = job.idempotencyKey;
    const existing = await this.ports.loadJob(key);
    // A stored hash means the job was broadcast, not necessarily mined. Callers still wait
    // for confirmation; retries must not allocate a new nonce merely to obtain that hash.
    if (existing?.txHash !== undefined) return existing.txHash;

    if (job.kind === "bumpLicenseEpoch") {
      const current = await this.ports.readLicenseEpoch(job.tokenId);
      if (current !== job.fromEpoch) {
        throw new AppError(
          "LICENSE_EPOCH_MISMATCH",
          "licenseEpoch already advanced past the epoch this revocation was decided against",
          { fromEpoch: job.fromEpoch.toString(), current: current.toString() },
        );
      }
    }

    // an earlier attempt without a hash is in unknown broadcast state: trust the chain
    const nonce =
      existing !== undefined
        ? await this.ports.getPendingNonce()
        : ((await this.ports.loadNonce()) ??
          (await this.ports.getPendingNonce()));
    await this.reserve(key, nonce);
    try {
      return await this.broadcast(job, key, nonce);
    } catch (error) {
      await this.ports.saveJob(key, { nonce, failed: true });
      if (!isNonceError(error)) {
        await this.ports.clearNonce();
        throw error;
      }
      const fresh = await this.ports.getPendingNonce();
      await this.reserve(key, fresh);
      try {
        return await this.broadcast(job, key, fresh);
      } catch (retryError) {
        await this.ports.saveJob(key, { nonce: fresh, failed: true });
        await this.ports.clearNonce();
        throw retryError;
      }
    }
  }

  private async reserve(key: string, nonce: number): Promise<void> {
    // Persist the reservation before the external side effect so an interrupted broadcast
    // is recognized as an existing attempt and reconciled against the pending chain nonce.
    await this.ports.saveNonce(nonce + 1);
    await this.ports.saveJob(key, { nonce });
  }

  private async broadcast(
    job: OperatorJob,
    key: string,
    nonce: number,
  ): Promise<Hex> {
    const txHash = await this.ports.submit(job, nonce);
    await this.ports.saveJob(key, { nonce, txHash });
    return txHash;
  }
}
