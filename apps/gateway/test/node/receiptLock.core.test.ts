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
};

function harness(
  options: Partial<Pick<Harness, "submitDelayMs" | "submitError">> & {
    maxUses?: number;
    usedCount?: number;
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
  const h: Harness = {
    rows,
    submits,
    clock,
    chain,
    submitDelayMs: options.submitDelayMs ?? 5,
    submitError: options.submitError,
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
        row.status = patch.status;
        if (patch.onchainTx !== undefined) row.onchainTx = patch.onchainTx;
        if (patch.settledAt !== undefined) row.settledAt = patch.settledAt;
        if (patch.relock !== undefined) {
          row.wallet = patch.relock.wallet;
          row.createdAt = patch.relock.createdAt;
        }
      },
      submitConsume: async (_r, useIndex) => {
        submits.push(useIndex);
        if (h.submitError !== undefined) throw h.submitError();
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

  it("should recover a stale locked row: consumed on chain -> settled + redelivered, else resend the SAME index", async () => {
    // crashed instance left useIndex 0 locked 2 minutes ago and the tx did land
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

    // crashed before sending: not consumed -> failed -> resent with the same index 1
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

  it("should initialise the counter from max(on-chain usedCount, stored rows) on cold start (mirror lag)", async () => {
    const h = harness({ usedCount: 1 }); // mirror node lags: chain says 1 but 3 are settled locally
    for (const idx of [0, 1, 2]) {
      h.rows.push({
        receiptHash: RECEIPT,
        useIndex: idx,
        wallet: BUYER,
        status: "settled",
        onchainTx: `0x${"aa".repeat(32)}`,
        settledAt: new Date(h.clock.now - 10 * 60_000),
        createdAt: new Date(h.clock.now - 11 * 60_000),
      });
    }
    const core = new ReceiptLockCore(h.ports);
    const out = await core.consume({ receiptHash: RECEIPT, wallet: BUYER });
    expect(out.useIndex).toBe(3);
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

  it("should refuse expired or unissued receipts before touching the database", async () => {
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
    expect(h.rows).toHaveLength(0);
  });
});
