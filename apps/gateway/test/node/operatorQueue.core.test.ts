import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  isNonceError,
  type JobRecord,
  type OperatorJob,
  OperatorQueueCore,
  type QueuePorts,
} from "../../src/do/operatorQueueCore";
import { AppError } from "../../src/errors";

const RECEIPT = `0x${"d4".repeat(32)}` as Hex;

type Event =
  | { kind: "saveNonce"; nonce: number }
  | { kind: "submit"; nonce: number }
  | { kind: "saveJob"; key: string; record: JobRecord };

function harness(options: { pending?: number; failNonce?: number } = {}) {
  let stored: number | undefined;
  const jobs = new Map<string, JobRecord>();
  let pending = options.pending ?? 7;
  const events: Event[] = [];
  const ports: QueuePorts = {
    getPendingNonce: async () => pending,
    loadNonce: async () => stored,
    saveNonce: async (n) => {
      stored = n;
      events.push({ kind: "saveNonce", nonce: n });
    },
    loadJob: async (key) => jobs.get(key),
    saveJob: async (key, record) => {
      jobs.set(key, record);
      events.push({ kind: "saveJob", key, record });
    },
    submit: async (_job, nonce) => {
      events.push({ kind: "submit", nonce });
      if (nonce === options.failNonce) {
        pending = 10; // chain moved on (another sender used our nonce)
        throw new Error("nonce too low");
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return `0x${nonce.toString(16).padStart(64, "0")}` as Hex;
    },
  };
  return {
    ports,
    events,
    jobs,
    stored: () => stored,
    seedJob: (key: string, record: JobRecord) => jobs.set(key, record),
    seedNonce: (n: number) => {
      stored = n;
    },
  };
}

const submits = (events: Event[]) =>
  events
    .filter((e) => e.kind === "submit")
    .map((e) => (e as { nonce: number }).nonce);

describe("OperatorQueueCore (R-3a nonce serialization)", () => {
  it("should give 20 parallel jobs strictly sequential nonces starting from the pending count", async () => {
    const h = harness({ pending: 7 });
    const core = new OperatorQueueCore(h.ports);
    const hashes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        core.enqueue({ kind: "consume", receiptHash: RECEIPT, useIndex: i }),
      ),
    );
    expect(submits(h.events)).toEqual(
      Array.from({ length: 20 }, (_, i) => 7 + i),
    );
    expect(new Set(hashes).size).toBe(20);
    expect(h.stored()).toBe(27);
  });

  it("should reserve the nonce (and the job record) durably BEFORE broadcasting", async () => {
    const h = harness({ pending: 3 });
    const core = new OperatorQueueCore(h.ports);
    const job: OperatorJob = {
      kind: "bumpLicenseEpoch",
      tokenId: 1n,
      idempotencyKey: "bump:1",
    };
    const hash = await core.enqueue(job);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds.indexOf("saveNonce")).toBeLessThan(kinds.indexOf("submit"));
    expect(kinds.indexOf("saveJob")).toBeLessThan(kinds.indexOf("submit"));
    expect(h.events[0]).toEqual({ kind: "saveNonce", nonce: 4 });
    expect(h.jobs.get("bump:1")).toEqual({ nonce: 3, txHash: hash });
  });

  it("should replay the recorded tx hash for a retried job instead of broadcasting again", async () => {
    const h = harness({ pending: 3 });
    const core = new OperatorQueueCore(h.ports);
    const job: OperatorJob = {
      kind: "consume",
      receiptHash: RECEIPT,
      useIndex: 0,
      idempotencyKey: "consume:x:0",
    };
    const first = await core.enqueue(job);
    const second = await core.enqueue(job);
    expect(second).toBe(first);
    expect(submits(h.events)).toEqual([3]);
  });

  it("should reuse the nonce reserved by a crashed attempt (record without tx hash)", async () => {
    const h = harness({ pending: 9 });
    h.seedNonce(6); // reservation of nonce 5 survived the crash
    h.seedJob("bump:7", { nonce: 5 });
    const core = new OperatorQueueCore(h.ports);
    await core.enqueue({
      kind: "bumpLicenseEpoch",
      tokenId: 7n,
      idempotencyKey: "bump:7",
    });
    expect(submits(h.events)).toEqual([5]);
    expect(h.stored()).toBe(6);
  });

  it("should resync from the chain and retry once on a nonce error", async () => {
    const h = harness({ pending: 3, failNonce: 3 });
    const core = new OperatorQueueCore(h.ports);
    const hash = await core.enqueue({ kind: "bumpLicenseEpoch", tokenId: 1n });
    expect(hash).toBe(`0x${"0a".padStart(64, "0")}`);
    expect(submits(h.events)).toEqual([3, 10]);
    expect(h.stored()).toBe(11);
  });

  it("should release the reservation on a simulation revert (nothing broadcast) and propagate the code", async () => {
    const h = harness({ pending: 2 });
    const failing: QueuePorts = {
      ...h.ports,
      submit: async () => {
        throw new AppError("USE_LIMIT_EXCEEDED");
      },
    };
    const core = new OperatorQueueCore(failing);
    await expect(
      core.enqueue({ kind: "consume", receiptHash: RECEIPT, useIndex: 0 }),
    ).rejects.toMatchObject({ code: "USE_LIMIT_EXCEEDED" });
    expect(h.stored()).toBe(2);
    expect(isNonceError(new AppError("USE_LIMIT_EXCEEDED"))).toBe(false);
    expect(isNonceError(new Error("Nonce too low"))).toBe(true);
  });
});
