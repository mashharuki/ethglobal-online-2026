import type { Hex } from "viem";

/**
 * OperatorTxQueue state machine (tasks.md T083, research.md R-3a problem 4). A single
 * instance serialises every transaction the operator key sends so two ReceiptLocks (different
 * receipts) can never race on the nonce.
 *
 * Nonce discipline: the nonce is RESERVED in durable storage (nonce + 1 saved, and the job
 * record written when the job carries an idempotency key) BEFORE the transaction is
 * broadcast. A crash between broadcast and return therefore never lets another job reuse
 * the nonce, and a retried job with the same key gets its recorded tx hash back instead of a
 * second broadcast. A simulation failure (nothing broadcast) releases the reservation.
 * On a "nonce too low / already known" rejection the nonce is re-synchronised from the
 * chain's pending count and the job retried once.
 *
 * Residual window: if the crash happened after broadcast but before the hash was recorded,
 * the retry at the reserved nonce is rejected by the node, re-synced and broadcast again -
 * a duplicate `consume` reverts harmlessly (ReceiptAlreadyConsumed -> recovered by
 * ReceiptLock), a duplicate `bumpLicenseEpoch` bumps twice (safe, over-revokes nothing).
 */
export type OperatorJob = (
  | { kind: "consume"; receiptHash: Hex; useIndex: number }
  | { kind: "bumpLicenseEpoch"; tokenId: bigint }
) & {
  /** stable identity of this logical job; enables the tx-hash replay on retries */
  idempotencyKey?: string;
};

export type JobRecord = { nonce: number; txHash?: Hex };

export type QueuePorts = {
  /** eth_getTransactionCount(operator, "pending") */
  getPendingNonce(): Promise<number>;
  loadNonce(): Promise<number | undefined>;
  saveNonce(nonce: number): Promise<void>;
  loadJob(key: string): Promise<JobRecord | undefined>;
  saveJob(key: string, record: JobRecord): Promise<void>;
  /** simulate + send; resolves to the tx hash, throws the mapped AppError on revert */
  submit(job: OperatorJob, nonce: number): Promise<Hex>;
};

const NONCE_ERROR_RE = /nonce/i;

export function isNonceError(error: unknown): boolean {
  return error instanceof Error && NONCE_ERROR_RE.test(error.message);
}

function jobKey(job: OperatorJob): string | undefined {
  return job.idempotencyKey;
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
    const key = jobKey(job);
    const existing =
      key === undefined ? undefined : await this.ports.loadJob(key);
    if (existing?.txHash !== undefined) return existing.txHash;

    // reuse the nonce reserved by a crashed attempt, else reserve the next one
    const nonce =
      existing?.nonce ??
      (await this.ports.loadNonce()) ??
      (await this.ports.getPendingNonce());
    if (existing === undefined) await this.reserve(key, nonce);

    try {
      return await this.broadcast(job, key, nonce);
    } catch (error) {
      if (!isNonceError(error)) {
        // nothing was broadcast (simulation revert etc.): release the reservation if it is
        // still the newest one
        if ((await this.ports.loadNonce()) === nonce + 1) {
          await this.ports.saveNonce(nonce);
        }
        throw error;
      }
      const fresh = await this.ports.getPendingNonce();
      await this.reserve(key, fresh);
      return this.broadcast(job, key, fresh);
    }
  }

  private async reserve(key: string | undefined, nonce: number): Promise<void> {
    await this.ports.saveNonce(nonce + 1);
    if (key !== undefined) await this.ports.saveJob(key, { nonce });
  }

  private async broadcast(
    job: OperatorJob,
    key: string | undefined,
    nonce: number,
  ): Promise<Hex> {
    const txHash = await this.ports.submit(job, nonce);
    if (key !== undefined) await this.ports.saveJob(key, { nonce, txHash });
    return txHash;
  }
}
