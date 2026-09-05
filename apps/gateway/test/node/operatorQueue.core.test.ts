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
  | { kind: "clearNonce" }
  | { kind: "submit"; nonce: number }
  | { kind: "saveJob"; key: string; record: JobRecord };

function harness(
  options: { pending?: number; failNonce?: number; licenseEpoch?: bigint } = {},
) {
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
    clearNonce: async () => {
      stored = undefined;
      events.push({ kind: "clearNonce" });
    },
    loadJob: async (key) => jobs.get(key),
    saveJob: async (key, record) => {
      jobs.set(key, record);
      events.push({ kind: "saveJob", key, record });
    },
    readLicenseEpoch: async () => options.licenseEpoch ?? 0n,
    submit: async (_job, nonce) => {
      events.push({ kind: "submit", nonce });
      if (nonce === options.failNonce) {
        pending = 10; // chain moved on (another sender used our nonce)
        throw new Error("nonce too low");
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      pending = nonce + 1;
      return `0x${nonce.toString(16).padStart(64, "0")}` as Hex;
    },
  };
  return {
    ports,
    events,
    jobs,
    stored: () => stored,
    pending: () => pending,
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

const consumeJob = (i: number, key = `consume:x:${i}`): OperatorJob => ({
  kind: "consume",
  receiptHash: RECEIPT,
  useIndex: i,
  idempotencyKey: key,
});

describe("OperatorQueueCore (R-3a nonce serialization)", () => {
  it("should give 20 parallel jobs strictly sequential nonces starting from the pending count", async () => {
    const h = harness({ pending: 7 });
    const core = new OperatorQueueCore(h.ports);
    const hashes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => core.enqueue(consumeJob(i))),
    );
    expect(submits(h.events)).toEqual(
      Array.from({ length: 20 }, (_, i) => 7 + i),
    );
    expect(new Set(hashes).size).toBe(20);
    expect(h.stored()).toBe(27);
  });

  it("should reserve the nonce and the job record durably BEFORE broadcasting", async () => {
    const h = harness({ pending: 3 });
    const core = new OperatorQueueCore(h.ports);
    const hash = await core.enqueue({
      kind: "bumpLicenseEpoch",
      tokenId: 1n,
      fromEpoch: 0n,
      idempotencyKey: "bump:1:n1",
    });
    const kinds = h.events.map((e) => e.kind);
    expect(kinds.indexOf("saveNonce")).toBeLessThan(kinds.indexOf("submit"));
    expect(kinds.indexOf("saveJob")).toBeLessThan(kinds.indexOf("submit"));
    expect(h.events[0]).toEqual({ kind: "saveNonce", nonce: 4 });
    expect(h.jobs.get("bump:1:n1")).toEqual({ nonce: 3, txHash: hash });
  });

  it("should replay the recorded tx hash for a retried job instead of broadcasting again", async () => {
    const h = harness({ pending: 3 });
    const core = new OperatorQueueCore(h.ports);
    const first = await core.enqueue(consumeJob(0));
    const second = await core.enqueue(consumeJob(0));
    expect(second).toBe(first);
    expect(submits(h.events)).toEqual([3]);
  });

  it("should treat a record without a hash (crashed attempt) as unknown and re-sync from the chain", async () => {
    const h = harness({ pending: 9 }); // chain says 9: the crashed broadcast at 5 landed (or not) - trust the chain
    h.seedNonce(6);
    h.seedJob("bump:7:n1", { nonce: 5 });
    const core = new OperatorQueueCore(h.ports);
    await core.enqueue({
      kind: "bumpLicenseEpoch",
      tokenId: 7n,
      fromEpoch: 0n,
      idempotencyKey: "bump:7:n1",
    });
    expect(submits(h.events)).toEqual([9]);
    expect(h.stored()).toBe(10);
  });

  it("should refuse a bumpLicenseEpoch whose fromEpoch is stale (duplicate revocation guard)", async () => {
    const h = harness({ pending: 3, licenseEpoch: 2n });
    const core = new OperatorQueueCore(h.ports);
    await expect(
      core.enqueue({
        kind: "bumpLicenseEpoch",
        tokenId: 1n,
        fromEpoch: 1n,
        idempotencyKey: "bump:1:n2",
      }),
    ).rejects.toMatchObject({ code: "LICENSE_EPOCH_MISMATCH" });
    expect(submits(h.events)).toEqual([]);
    expect(h.stored()).toBeUndefined();
    const hash = await core.enqueue({
      kind: "bumpLicenseEpoch",
      tokenId: 1n,
      fromEpoch: 2n,
      idempotencyKey: "bump:1:n3",
    });
    expect(hash).toMatch(/^0x/);
  });

  it("should resync from the chain and retry once on a nonce error", async () => {
    const h = harness({ pending: 3, failNonce: 3 });
    const core = new OperatorQueueCore(h.ports);
    const hash = await core.enqueue(consumeJob(4));
    expect(hash).toBe(`0x${"0a".padStart(64, "0")}`);
    expect(submits(h.events)).toEqual([3, 10]);
    expect(h.stored()).toBe(11);
  });

  it("should clear the stored nonce after any other failure so the next job re-syncs, and mark the record failed", async () => {
    const h = harness({ pending: 2 });
    let fail = true;
    const flaky: QueuePorts = {
      ...h.ports,
      submit: async (job, nonce) => {
        if (fail) throw new AppError("USE_LIMIT_EXCEEDED");
        return h.ports.submit(job, nonce);
      },
    };
    const core = new OperatorQueueCore(flaky);
    await expect(core.enqueue(consumeJob(0))).rejects.toMatchObject({
      code: "USE_LIMIT_EXCEEDED",
    });
    expect(h.jobs.get("consume:x:0")).toEqual({ nonce: 2, failed: true });
    expect(h.stored()).toBeUndefined();
    fail = false;
    // next job re-syncs from the chain (2: nothing was broadcast) rather than a stale counter
    await core.enqueue(consumeJob(1));
    expect(submits(h.events)).toEqual([2]);
    expect(isNonceError(new AppError("USE_LIMIT_EXCEEDED"))).toBe(false);
    expect(isNonceError(new Error("Nonce too low"))).toBe(true);
  });
});
