import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  type ConsumptionRow,
  LOCK_STALE_MS,
  type LockPorts,
  REDELIVERY_TTL_MS,
  ReceiptLockCore,
} from "../../src/do/receiptLockCore";
import { AppError } from "../../src/errors";

/**
 * ReceiptLock state machine (T083 / T065 gateway slice) against in-memory ports: proves the
 * serialization / recovery rules without a relay. The DO + Hyperdrive + real consume run is
 * the Phase 8 E2E gate (BLOCKED until deploy).
 */
const RECEIPT = `0x${"d4".repeat(32)}` as Hex;
const BUYER: Address = "0x00000000000000000000000000000000000000b1";
const OTHER: Address = "0x00000000000000000000000000000000000000c2";

type Harness = {
  ports: LockPorts;
  rows: ConsumptionRow[];
  submits: number[];
  inserts: number;
  clock: { now: number };
  chain: {
    maxUses: number;
    usedCount: number;
    consumed: Set<number>;
    expiresAt: bigint;
    issued: boolean;
  };
  submitDelayMs: number;
  submitError?: () => Error;
  /** resolves when the next submitConsume has started (to interleave requests) */
  submitStarted: () => Promise<void>;
  releaseSubmit: () => void;
};

function harness(
  options: Partial<Pick<Harness, "submitDelayMs" | "submitError">> & {
    maxUses?: number;
    usedCount?: number;
    manualSubmit?: boolean;
  } = {},
): Harness {
  const clock = { now: Date.parse("2026-09-06T12:00:00Z") };
  const rows: ConsumptionRow[] = [];
  const submits: number[] = [];
  const chain = {
    maxUses: options.maxUses ?? 5,
    usedCount: options.usedCount ?? 0,
    consumed: new Set<number>(),
    expiresAt: BigInt(Math.floor(clock.now / 1000) + 300),
    issued: true,
  };
  let started: (() => void) | undefined;
  let release: (() => void) | undefined;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h: Harness = {
    rows,
    submits,
    inserts: 0,
    clock,
    chain,
    submitDelayMs: options.submitDelayMs ?? 5,
    submitError: options.submitError,
    submitStarted: () => startedPromise,
    releaseSubmit: () => release?.(),
    ports: {
      now: () => new Date(clock.now),
      readReceipt: async () => ({
        issued: chain.issued,
        maxUses: chain.maxUses,
        usedCount: chain.usedCount,
        expiresAt: chain.expiresAt,
      }),
      readIsConsumed: async (_r, idx) => chain.consumed.has(idx),
      listRows: async () => rows.map((r) => ({ ...r })),
      insertLocked: async (receiptHash, useIndex, wallet) => {
        h.inserts += 1;
        if (rows.some((r) => r.useIndex === useIndex)) return false;
        rows.push({
          receiptHash,
          useIndex,
          wallet,
          status: "locked",
          onchainTx: null,
          settledAt: null,
          createdAt: new Date(clock.now),
        });
        return true;
      },
      updateStatus: async (_r, useIndex, patch) => {
        const row = rows.find((x) => x.useIndex === useIndex);
        if (row === undefined) throw new Error("row missing");
        if (patch.ifStatus !== undefined && row.status !== patch.ifStatus) {
          return false;
        }
        row.status = patch.status;
        if (patch.onchainTx !== undefined) row.onchainTx = patch.onchainTx;
        if (patch.settledAt !== undefined) row.settledAt = patch.settledAt;
        if (patch.relock !== undefined) {
          row.wallet = patch.relock.wallet;
          row.createdAt = patch.relock.createdAt;
        }
        return true;
      },
      submitConsume: async (_r, useIndex) => {
        submits.push(useIndex);
        started?.();
        if (h.submitError !== undefined) throw h.submitError();
        if (options.manualSubmit) await gate;
        else
          await new Promise((resolve) => setTimeout(resolve, h.submitDelayMs));
        chain.consumed.add(useIndex);
        chain.usedCount += 1;
        return `0x${useIndex.toString(16).padStart(64, "0")}` as Hex;
      },
      waitForTx: async () => {},
    },
  };
  return h;
}

async function codeOf(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return error instanceof AppError
      ? error.code
      : `unexpected:${String(error)}`;
  }
}

function settledRow(
  h: Harness,
  useIndex: number,
  wallet: Address,
  ageMs: number,
): void {
  h.rows.push({
    receiptHash: RECEIPT,
    useIndex,
    wallet,
    status: "settled",
    onchainTx: `0x${"aa".repeat(32)}`,
    settledAt: new Date(h.clock.now - ageMs),
    createdAt: new Date(h.clock.now - ageMs - 1000),
  });
}

describe("ReceiptLockCore (R-3 / R-3a)", () => {
  it("should let exactly one of 20 parallel requests consume and reject 19 with RECEIPT_ALREADY_CONSUMED", async () => {
    const h = harness({ submitDelayMs: 40 });
    const core = new ReceiptLockCore(h.ports);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        core.consume({ receiptHash: RECEIPT, wallet: BUYER }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    expect(
      rejected.every(
        (r) =>
          r.reason instanceof AppError &&
          r.reason.code === "RECEIPT_ALREADY_CONSUMED",
      ),
    ).toBe(true);
    expect(h.submits).toEqual([0]);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]?.status).toBe("settled");
  });

  it("should allocate sequential useIndex values across sequential requests up to maxUses", async () => {
    const h = harness({ maxUses: 3 });
    const core = new ReceiptLockCore(h.ports);
    for (let i = 0; i < 3; i += 1) {
      const out = await core.consume({ receiptHash: RECEIPT, wallet: BUYER });
      expect(out.useIndex).toBe(i);
      expect(out.redelivered).toBe(false);
      h.clock.now += 1000;
    }
    expect(
      await codeOf(core.consume({ receiptHash: RECEIPT, wallet: BUYER })),
    ).toBe("USE_LIMIT_EXCEEDED");
    expect(h.submits).toEqual([0, 1, 2]);
  });

  it("should start from the on-chain usedCount on a cold start with no stored rows", async () => {
    const h = harness({ usedCount: 2 });
    const core = new ReceiptLockCore(h.ports);
    const out = await core.consume({ receiptHash: RECEIPT, wallet: BUYER });
    expect(out.useIndex).toBe(2);
    expect(h.submits).toEqual([2]);
  });

  it("should initialise the counter from max(on-chain usedCount, stored rows) when the mirror lags", async () => {
    const h = harness({ usedCount: 1 });
    for (const idx of [0, 1, 2]) settledRow(h, idx, BUYER, 10 * 60_000);
    const core = new ReceiptLockCore(h.ports);
    const out = await core.consume({ receiptHash: RECEIPT, wallet: BUYER });
    expect(out.useIndex).toBe(3);
  });

  it("should re-deliver a settled useIndex to the same wallet within 5 min without a new consume (FR-007)", async () => {
    const h = harness();
    const core = new ReceiptLockCore(h.ports);
    const first = await core.consume({ receiptHash: RECEIPT, wallet: BUYER });
    h.clock.now += 60_000;
    const again = await core.consume({
      receiptHash: RECEIPT,
      wallet: BUYER,
      retryUseIndex: first.useIndex,
    });
    expect(again).toEqual({
      useIndex: 0,
      onchainTx: first.onchainTx,
      redelivered: true,
    });
    expect(
      await codeOf(
        core.consume({ receiptHash: RECEIPT, wallet: OTHER, retryUseIndex: 0 }),
      ),
    ).toBe("RECEIPT_ALREADY_CONSUMED");
    h.clock.now += REDELIVERY_TTL_MS;
    expect(
      await codeOf(
        core.consume({ receiptHash: RECEIPT, wallet: BUYER, retryUseIndex: 0 }),
      ),
    ).toBe("RECEIPT_ALREADY_CONSUMED");
    expect(h.submits).toEqual([0]);
  });

  it("should never recover a row whose settle is still in flight, even after the stale window", async () => {
    const h = harness({ manualSubmit: true });
    const core = new ReceiptLockCore(h.ports);
    const inflight = core.consume({ receiptHash: RECEIPT, wallet: BUYER });
    await h.submitStarted();
    h.clock.now += LOCK_STALE_MS + 5_000; // looks stale from the outside
    expect(
      await codeOf(core.consume({ receiptHash: RECEIPT, wallet: OTHER })),
    ).toBe("RECEIPT_ALREADY_CONSUMED");
    expect(h.rows[0]?.status).toBe("locked");
    expect(h.rows[0]?.wallet).toBe(BUYER);
    h.releaseSubmit();
    const out = await inflight;
    expect(out.useIndex).toBe(0);
    expect(h.rows[0]?.status).toBe("settled");
    expect(h.submits).toEqual([0]);
  });

  it("should recover a stale locked row: consumed on chain -> settled + redelivered, else resend the SAME index", async () => {
    const h = harness();
    h.rows.push({
      receiptHash: RECEIPT,
      useIndex: 0,
      wallet: BUYER,
      status: "locked",
      onchainTx: null,
      settledAt: null,
      createdAt: new Date(h.clock.now - LOCK_STALE_MS - 60_000),
    });
    h.chain.consumed.add(0);
    h.chain.usedCount = 1;
    const core = new ReceiptLockCore(h.ports);
    const out = await core.consume({ receiptHash: RECEIPT, wallet: BUYER });
    expect(out).toEqual({
      useIndex: 0,
      onchainTx: undefined,
      redelivered: true,
    });
    expect(h.rows[0]?.status).toBe("settled");
    expect(h.submits).toEqual([]);

    const g = harness({ maxUses: 2 });
    g.rows.push({
      receiptHash: RECEIPT,
      useIndex: 1,
      wallet: BUYER,
      status: "locked",
      onchainTx: null,
      settledAt: null,
      createdAt: new Date(g.clock.now - LOCK_STALE_MS - 1),
    });
    const core2 = new ReceiptLockCore(g.ports);
    const resent = await core2.consume({ receiptHash: RECEIPT, wallet: BUYER });
    expect(resent.useIndex).toBe(1);
    expect(g.submits).toEqual([1]);
    expect(g.rows.find((r) => r.useIndex === 1)?.status).toBe("settled");
  });

  it("should deliver a failed row that turns out consumed instead of allocating a new index", async () => {
    const h = harness({ maxUses: 1 });
    h.rows.push({
      receiptHash: RECEIPT,
      useIndex: 0,
      wallet: BUYER,
      status: "failed",
      onchainTx: null,
      settledAt: null,
      createdAt: new Date(h.clock.now - 5_000),
    });
    h.chain.consumed.add(0);
    h.chain.usedCount = 1;
    const core = new ReceiptLockCore(h.ports);
    const out = await core.consume({ receiptHash: RECEIPT, wallet: BUYER });
    expect(out).toEqual({
      useIndex: 0,
      onchainTx: undefined,
      redelivered: true,
    });
    expect(h.submits).toEqual([]);
    expect(h.inserts).toBe(0);
  });

  it("should mark the row failed and propagate the mapped revert, then reuse the same index next time", async () => {
    const h = harness({
      submitError: () => new AppError("LICENSE_EPOCH_MISMATCH"),
    });
    const core = new ReceiptLockCore(h.ports);
    expect(
      await codeOf(core.consume({ receiptHash: RECEIPT, wallet: BUYER })),
    ).toBe("LICENSE_EPOCH_MISMATCH");
    expect(h.rows[0]?.status).toBe("failed");
    h.submitError = undefined;
    const retry = await core.consume({ receiptHash: RECEIPT, wallet: BUYER });
    expect(retry.useIndex).toBe(0);
    expect(h.submits).toEqual([0, 0]);
  });

  it("should not let a late revert overwrite a settlement recorded by recovery (conditional transition)", async () => {
    const h = harness();
    const core = new ReceiptLockCore(h.ports);
    await core.consume({ receiptHash: RECEIPT, wallet: BUYER });
    // simulate a lost race: the row is already settled; a stale failed transition must be a no-op
    const applied = await h.ports.updateStatus(RECEIPT, 0, {
      status: "failed",
      ifStatus: "locked",
    });
    expect(applied).toBe(false);
    expect(h.rows[0]?.status).toBe("settled");
  });

  it("should refuse expired or unissued receipts without inserting a row", async () => {
    const h = harness();
    h.chain.expiresAt = BigInt(Math.floor(h.clock.now / 1000) - 1);
    const core = new ReceiptLockCore(h.ports);
    expect(
      await codeOf(core.consume({ receiptHash: RECEIPT, wallet: BUYER })),
    ).toBe("RECEIPT_EXPIRED");
    h.chain.expiresAt = BigInt(Math.floor(h.clock.now / 1000) + 300);
    h.chain.issued = false;
    expect(
      await codeOf(core.consume({ receiptHash: RECEIPT, wallet: BUYER })),
    ).toBe("NOT_AUTHORIZED");
    expect(h.inserts).toBe(0);
    expect(h.rows).toHaveLength(0);
  });
});
