import { type Address, type Hex, isAddressEqual } from "viem";
import type { ConsumptionStatus } from "../db/schema";
import { AppError } from "../errors";

/**
 * ReceiptLock state machine (tasks.md T083, research.md R-3 / R-3a). One instance per
 * receiptHash. The critical section (reconcile -> allocate useIndex -> INSERT locked row) is
 * serialized in-process; the slow part (consume tx submit + confirmation) runs outside it so
 * concurrent requests observe the `locked` row and are rejected with RECEIPT_ALREADY_CONSUMED
 * instead of queueing up behind a multi-second transaction.
 *
 * Rules implemented (gateway-api.md /keygate/share, data-model.md receipt_consumption):
 * - cold start: reconcile stale `locked` rows (> 60 s) via consumed[receipt][idx] BEFORE the
 *   counter is initialised; counter = max(on-chain usedCount, highest stored useIndex + 1);
 *   a consumption that turns out settled is delivered to its wallet on that first request
 * - `locked` row younger than 60 s -> RECEIPT_ALREADY_CONSUMED (in progress)
 * - `locked` row older than 60 s: consumed on chain -> settled (redelivered to the same
 *   wallet), else -> the SAME useIndex is resent (never a fresh index: maxUses boundary)
 * - `settled` within 5 min + retryUseIndex from the same wallet -> re-deliver, no new consume
 * - counter >= maxUses -> USE_LIMIT_EXCEEDED before any transaction is sent
 */
export const LOCK_STALE_MS = 60_000;
export const REDELIVERY_TTL_MS = 5 * 60_000;

export type ConsumptionRow = {
  receiptHash: Hex;
  useIndex: number;
  wallet: Address;
  status: ConsumptionStatus;
  onchainTx: Hex | null;
  settledAt: Date | null;
  createdAt: Date;
};

type ReceiptSnapshot = {
  issued: boolean;
  maxUses: number;
  usedCount: number;
  /** unix seconds */
  expiresAt: bigint;
};

type StatusPatch = {
  status: ConsumptionStatus;
  onchainTx?: Hex;
  settledAt?: Date;
  /** re-arm a recovered row for a new attempt */
  relock?: { wallet: Address; createdAt: Date };
};

export type LockPorts = {
  now(): Date;
  readReceipt(receiptHash: Hex): Promise<ReceiptSnapshot>;
  readIsConsumed(receiptHash: Hex, useIndex: number): Promise<boolean>;
  listRows(receiptHash: Hex): Promise<ConsumptionRow[]>;
  /** false when the UNIQUE(receipt_hash, use_index) row already exists */
  insertLocked(
    receiptHash: Hex,
    useIndex: number,
    wallet: Address,
  ): Promise<boolean>;
  updateStatus(
    receiptHash: Hex,
    useIndex: number,
    patch: StatusPatch,
  ): Promise<void>;
  /** OperatorTxQueue: returns the tx hash; throws the mapped AppError on revert */
  submitConsume(receiptHash: Hex, useIndex: number): Promise<Hex>;
  waitForTx(txHash: Hex): Promise<void>;
};

export type ConsumeInput = {
  receiptHash: Hex;
  wallet: Address;
  retryUseIndex?: number;
};

export type ConsumeOutcome = {
  useIndex: number;
  onchainTx: Hex | undefined;
  redelivered: boolean;
};

type Plan =
  | { kind: "consume"; useIndex: number }
  | { kind: "redeliver"; useIndex: number; onchainTx: Hex | undefined };

function redeliver(row: ConsumptionRow): Plan {
  return {
    kind: "redeliver",
    useIndex: row.useIndex,
    onchainTx: row.onchainTx ?? undefined,
  };
}

export class ReceiptLockCore {
  private readonly counters = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly ports: LockPorts) {}

  async consume(input: ConsumeInput): Promise<ConsumeOutcome> {
    const plan = await this.serialize(() => this.plan(input));
    if (plan.kind === "redeliver") {
      return {
        useIndex: plan.useIndex,
        onchainTx: plan.onchainTx,
        redelivered: true,
      };
    }
    return this.settle(input.receiptHash, plan.useIndex);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async plan(input: ConsumeInput): Promise<Plan> {
    const { receiptHash, wallet } = input;
    const now = this.ports.now();
    const rows = await this.ports.listRows(receiptHash);
    const recoveredAtStart = await this.ensureCounter(receiptHash, rows, now);

    if (input.retryUseIndex !== undefined) {
      return this.planRedelivery(rows, input.retryUseIndex, wallet, now);
    }

    // cold-start reconcile found a settled-but-undelivered consumption for this wallet
    const owed = recoveredAtStart.find((r) => isAddressEqual(r.wallet, wallet));
    if (owed !== undefined) return redeliver(owed);

    for (const row of rows) {
      if (row.status !== "locked") continue;
      if (now.getTime() - row.createdAt.getTime() <= LOCK_STALE_MS) {
        throw new AppError("RECEIPT_ALREADY_CONSUMED", "consume in progress");
      }
      const recovered = await this.recoverStale(row, now);
      if (recovered === "settled") {
        if (isAddressEqual(row.wallet, wallet)) return redeliver(row);
        continue;
      }
      await this.relock(receiptHash, row.useIndex, wallet, now);
      return { kind: "consume", useIndex: row.useIndex };
    }

    // a failed attempt keeps its useIndex: resend the same index (R-3a, 2026-09-06 correction)
    for (const row of rows) {
      if (row.status !== "failed") continue;
      if (await this.ports.readIsConsumed(receiptHash, row.useIndex)) {
        await this.ports.updateStatus(receiptHash, row.useIndex, {
          status: "settled",
          settledAt: now,
        });
        continue;
      }
      await this.relock(receiptHash, row.useIndex, wallet, now);
      return { kind: "consume", useIndex: row.useIndex };
    }

    const receipt = await this.ports.readReceipt(receiptHash);
    if (!receipt.issued) {
      throw new AppError("NOT_AUTHORIZED", "receipt is not issued");
    }
    if (receipt.expiresAt <= BigInt(Math.floor(now.getTime() / 1000))) {
      throw new AppError("RECEIPT_EXPIRED");
    }
    let useIndex = this.counters.get(receiptHash) ?? receipt.usedCount;
    for (;;) {
      if (useIndex >= receipt.maxUses) throw new AppError("USE_LIMIT_EXCEEDED");
      if (await this.ports.insertLocked(receiptHash, useIndex, wallet)) break;
      useIndex += 1; // row already exists (settled elsewhere): skip forward
    }
    this.counters.set(receiptHash, useIndex + 1);
    return { kind: "consume", useIndex };
  }

  private async relock(
    receiptHash: Hex,
    useIndex: number,
    wallet: Address,
    now: Date,
  ): Promise<void> {
    await this.ports.updateStatus(receiptHash, useIndex, {
      status: "locked",
      relock: { wallet, createdAt: now },
    });
  }

  private async planRedelivery(
    rows: ConsumptionRow[],
    useIndex: number,
    wallet: Address,
    now: Date,
  ): Promise<Plan> {
    const row = rows.find((r) => r.useIndex === useIndex);
    if (
      row?.status === "settled" &&
      row.settledAt !== null &&
      now.getTime() - row.settledAt.getTime() <= REDELIVERY_TTL_MS &&
      isAddressEqual(row.wallet, wallet)
    ) {
      return redeliver(row);
    }
    throw new AppError(
      "RECEIPT_ALREADY_CONSUMED",
      "no re-deliverable consumption for this useIndex (settled > 5 min ago, other wallet, or unknown)",
    );
  }

  private async recoverStale(
    row: ConsumptionRow,
    now: Date,
  ): Promise<"settled" | "failed"> {
    const consumed = await this.ports.readIsConsumed(
      row.receiptHash,
      row.useIndex,
    );
    if (consumed) {
      await this.ports.updateStatus(row.receiptHash, row.useIndex, {
        status: "settled",
        settledAt: now,
      });
      row.status = "settled";
      row.settledAt = now;
      return "settled";
    }
    await this.ports.updateStatus(row.receiptHash, row.useIndex, {
      status: "failed",
    });
    row.status = "failed";
    return "failed";
  }

  /**
   * Cold start (R-3a 補足): reconcile stale locked rows, then initialise the counter.
   * Returns the rows that turned out settled so the caller can deliver them.
   */
  private async ensureCounter(
    receiptHash: Hex,
    rows: ConsumptionRow[],
    now: Date,
  ): Promise<ConsumptionRow[]> {
    if (this.counters.has(receiptHash)) return [];
    const settled: ConsumptionRow[] = [];
    for (const row of rows) {
      if (
        row.status === "locked" &&
        now.getTime() - row.createdAt.getTime() > LOCK_STALE_MS &&
        (await this.recoverStale(row, now)) === "settled"
      ) {
        settled.push(row);
      }
    }
    const receipt = await this.ports.readReceipt(receiptHash);
    const highest = rows.reduce((max, r) => Math.max(max, r.useIndex), -1);
    this.counters.set(receiptHash, Math.max(receipt.usedCount, highest + 1));
    return settled;
  }

  private async settle(
    receiptHash: Hex,
    useIndex: number,
  ): Promise<ConsumeOutcome> {
    let txHash: Hex;
    try {
      txHash = await this.ports.submitConsume(receiptHash, useIndex);
    } catch (error) {
      await this.ports.updateStatus(receiptHash, useIndex, {
        status: "failed",
      });
      throw error;
    }
    try {
      await this.ports.waitForTx(txHash);
    } catch (error) {
      await this.ports.updateStatus(receiptHash, useIndex, {
        status: "failed",
        onchainTx: txHash,
      });
      throw error;
    }
    await this.ports.updateStatus(receiptHash, useIndex, {
      status: "settled",
      onchainTx: txHash,
      settledAt: this.ports.now(),
    });
    return { useIndex, onchainTx: txHash, redelivered: false };
  }
}
