import type { Address, Hex } from "viem";
import {
  type Api,
  GatewayError,
  keygateShare,
  licenseeChallenge,
} from "../api/client";
import type { Signers, TypedDataLike } from "../chain/hooks";

/**
 * Concurrent Replay (tasks.md T109 AttackCounter / T116, SC-005): N parallel /keygate/share
 * calls with the SAME receipt. Each call carries its own fresh challenge signature (nonces are
 * single use), so what is being attacked is the receipt's use accounting, not the auth: the
 * ReceiptLock Durable Object serializes them and exactly one useIndex settles per call slot,
 * the rest are rejected with a domain code.
 */
export type ReplayOutcome =
  | { ok: true; useIndex: number }
  | { ok: false; code: string };

export type ReplaySummary = {
  total: number;
  settled: number;
  rejected: number;
  codes: Record<string, number>;
};

export function summarizeOutcomes(outcomes: ReplayOutcome[]): ReplaySummary {
  const codes: Record<string, number> = {};
  let settled = 0;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      settled += 1;
    } else {
      codes[outcome.code] = (codes[outcome.code] ?? 0) + 1;
    }
  }
  return {
    total: outcomes.length,
    settled,
    rejected: outcomes.length - settled,
    codes,
  };
}

export async function runConcurrentReplay(input: {
  api: Api;
  signers: Signers;
  wallet: Address;
  assetId: Hex;
  receiptHash: Hex;
  parallelism: number;
}): Promise<ReplayOutcome[]> {
  // signatures first (sequential: one wallet), then every request in flight at once
  const signed: Hex[] = [];
  for (let i = 0; i < input.parallelism; i += 1) {
    const challenge = await licenseeChallenge(input.api, {
      receiptHash: input.receiptHash,
      wallet: input.wallet,
    });
    signed.push(
      await input.signers.signTypedData(challenge.typedData as TypedDataLike),
    );
  }
  return Promise.all(
    signed.map(async (authSig): Promise<ReplayOutcome> => {
      try {
        const released = await keygateShare(input.api, {
          path: "licensee",
          assetId: input.assetId,
          receiptHash: input.receiptHash,
          authSig,
        });
        return released.path === "licensee"
          ? { ok: true, useIndex: released.useIndex }
          : { ok: false, code: "UNEXPECTED_SHAPE" };
      } catch (error) {
        return {
          ok: false,
          code: error instanceof GatewayError ? error.code : "NETWORK",
        };
      }
    }),
  );
}
