import type { Hex } from "viem";

/**
 * OperatorTxQueue state machine (tasks.md T083, research.md R-3a problem 4). A single
 * instance serialises every transaction the operator key sends so two ReceiptLocks (different
 * receipts) can never race on the nonce. The next nonce lives in durable storage; on a
 * "nonce too low / already known" rejection it is re-synchronised from the chain's pending
 * count and the job is retried once.
 */
export type OperatorJob =
  | { kind: "consume"; receiptHash: Hex; useIndex: number }
  | { kind: "bumpLicenseEpoch"; tokenId: bigint };

export type QueuePorts = {
  /** eth_getTransactionCount(operator, "pending") */
  getPendingNonce(): Promise<number>;
  loadNonce(): Promise<number | undefined>;
  saveNonce(nonce: number): Promise<void>;
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
    let nonce =
      (await this.ports.loadNonce()) ?? (await this.ports.getPendingNonce());
    try {
      return await this.submitAndAdvance(job, nonce);
    } catch (error) {
      if (!isNonceError(error)) throw error;
      nonce = await this.ports.getPendingNonce();
      return this.submitAndAdvance(job, nonce);
    }
  }

  private async submitAndAdvance(
    job: OperatorJob,
    nonce: number,
  ): Promise<Hex> {
    const txHash = await this.ports.submit(job, nonce);
    await this.ports.saveNonce(nonce + 1);
    return txHash;
  }
}
