import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  isNonceError,
  type OperatorJob,
  OperatorQueueCore,
  type QueuePorts,
} from "../../src/do/operatorQueueCore";
import { AppError } from "../../src/errors";

const RECEIPT = `0x${"d4".repeat(32)}` as Hex;

function harness(options: { pending?: number; failNonce?: number } = {}) {
  let stored: number | undefined;
  let pending = options.pending ?? 7;
  const submitted: Array<{ job: OperatorJob; nonce: number }> = [];
  const ports: QueuePorts = {
    getPendingNonce: async () => pending,
    loadNonce: async () => stored,
    saveNonce: async (n) => {
      stored = n;
    },
    submit: async (job, nonce) => {
      if (nonce === options.failNonce) {
        pending = 10; // chain moved on (another sender used our nonce)
        throw new Error("nonce too low");
      }
      submitted.push({ job, nonce });
      await new Promise((resolve) => setTimeout(resolve, 2));
      return `0x${nonce.toString(16).padStart(64, "0")}` as Hex;
    },
  };
  return { ports, submitted, stored: () => stored };
}

describe("OperatorQueueCore (R-3a nonce serialization)", () => {
  it("should give 20 parallel jobs strictly sequential nonces starting from the pending count", async () => {
    const h = harness({ pending: 7 });
    const core = new OperatorQueueCore(h.ports);
    const hashes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        core.enqueue({ kind: "consume", receiptHash: RECEIPT, useIndex: i }),
      ),
    );
    expect(h.submitted.map((s) => s.nonce)).toEqual(
      Array.from({ length: 20 }, (_, i) => 7 + i),
    );
    expect(new Set(hashes).size).toBe(20);
    expect(h.stored()).toBe(27);
  });

  it("should resync from the chain and retry once on a nonce error", async () => {
    const h = harness({ pending: 3, failNonce: 3 });
    const core = new OperatorQueueCore(h.ports);
    const hash = await core.enqueue({ kind: "bumpLicenseEpoch", tokenId: 1n });
    expect(hash).toBe(`0x${"0a".padStart(64, "0")}`);
    expect(h.submitted.map((s) => s.nonce)).toEqual([10]);
    expect(h.stored()).toBe(11);
  });

  it("should propagate a mapped revert without advancing the nonce", async () => {
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
    expect(h.stored()).toBeUndefined();
    expect(isNonceError(new AppError("USE_LIMIT_EXCEEDED"))).toBe(false);
    expect(isNonceError(new Error("Nonce too low"))).toBe(true);
  });
});
