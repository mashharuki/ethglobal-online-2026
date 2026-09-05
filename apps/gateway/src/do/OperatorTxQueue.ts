import { DurableObject } from "cloudflare:workers";
import type { Hex } from "viem";
import { createChainContext, createOperatorWallet } from "../chain/clients";
import {
  submitBumpLicenseEpoch,
  submitConsume,
  type WriteContext,
} from "../chain/writes";
import type { Env } from "../env";
import {
  type JobRecord,
  type OperatorJob,
  OperatorQueueCore,
  type QueuePorts,
} from "./operatorQueueCore";
import { doErrorResponse, doFailure } from "./respond";

/**
 * OperatorTxQueue Durable Object (tasks.md T083, R-3a): the single instance
 * (`idFromName("operator")`) through which every operator-key transaction is sent. Nonce
 * reservation and job records are persisted in DO storage (see operatorQueueCore.ts).
 */
const NONCE_KEY = "operator-nonce";
const JOB_PREFIX = "job:";
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const KEY_RE = /^[A-Za-z0-9:_.-]{1,200}$/;

function parseJob(value: unknown): OperatorJob | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const idempotencyKey =
    v.idempotencyKey === undefined
      ? undefined
      : typeof v.idempotencyKey === "string" && KEY_RE.test(v.idempotencyKey)
        ? v.idempotencyKey
        : null;
  if (idempotencyKey === null) return undefined;
  if (v.kind === "consume") {
    if (typeof v.receiptHash !== "string" || !HEX32.test(v.receiptHash))
      return undefined;
    if (
      typeof v.useIndex !== "number" ||
      !Number.isInteger(v.useIndex) ||
      v.useIndex < 0
    )
      return undefined;
    return {
      kind: "consume",
      receiptHash: v.receiptHash as Hex,
      useIndex: v.useIndex,
      idempotencyKey,
    };
  }
  if (v.kind === "bumpLicenseEpoch") {
    if (typeof v.tokenId !== "string" || !/^\d+$/.test(v.tokenId))
      return undefined;
    return {
      kind: "bumpLicenseEpoch",
      tokenId: BigInt(v.tokenId),
      idempotencyKey,
    };
  }
  return undefined;
}

function createQueuePorts(env: Env, storage: DurableObjectStorage): QueuePorts {
  let write: WriteContext | undefined;
  const ctx = (): WriteContext => {
    if (write === undefined) {
      const chain = createChainContext(env);
      write = { ...chain, wallet: createOperatorWallet(env, chain) };
    }
    return write;
  };
  return {
    getPendingNonce: async () => {
      const c = ctx();
      return c.publicClient.getTransactionCount({
        address: c.wallet.account.address,
        blockTag: "pending",
      });
    },
    loadNonce: () => storage.get<number>(NONCE_KEY),
    saveNonce: (nonce) => storage.put(NONCE_KEY, nonce),
    loadJob: (key) => storage.get<JobRecord>(`${JOB_PREFIX}${key}`),
    saveJob: (key, record) => storage.put(`${JOB_PREFIX}${key}`, record),
    submit: (job, nonce) =>
      job.kind === "consume"
        ? submitConsume(ctx(), job.receiptHash, job.useIndex, { nonce })
        : submitBumpLicenseEpoch(ctx(), job.tokenId, { nonce }),
  };
}

export class OperatorTxQueue extends DurableObject<Env> {
  private core: OperatorQueueCore | undefined;

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return doFailure("METHOD_NOT_ALLOWED", "POST only", 405);
    }
    let job: OperatorJob | undefined;
    try {
      job = parseJob(await request.json());
    } catch {
      job = undefined;
    }
    if (job === undefined) {
      return doFailure(
        "BAD_REQUEST",
        "expected a consume or bumpLicenseEpoch job",
        400,
      );
    }
    this.core ??= new OperatorQueueCore(
      createQueuePorts(this.env, this.ctx.storage),
    );
    try {
      const txHash = await this.core.enqueue(job);
      return Response.json({ ok: true, txHash });
    } catch (error) {
      return doErrorResponse(error, "OperatorTxQueue");
    }
  }
}
