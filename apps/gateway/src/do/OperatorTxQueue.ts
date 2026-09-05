import { DurableObject } from "cloudflare:workers";
import type { Address, Hex } from "viem";
import { createChainContext, createOperatorWallet } from "../chain/clients";
import { readLicenseEpoch } from "../chain/reads";
import {
  type ReceiptParams,
  submitBumpLicenseEpoch,
  submitConsume,
  submitFinalize,
  submitSettleAndIssue,
  type WriteContext,
} from "../chain/writes";
import type { Env } from "../env";
import {
  type JobRecord,
  type OperatorJob,
  OperatorQueueCore,
  type QueuePorts,
  type ReceiptParamsJson,
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
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const KEY_RE = /^[A-Za-z0-9:_.-]{1,200}$/;
const DECIMAL_RE = /^\d+$/;

function isHex32(v: unknown): v is Hex {
  return typeof v === "string" && HEX32.test(v);
}
function isAddress(v: unknown): v is Address {
  return typeof v === "string" && ADDRESS.test(v);
}
function isDecimal(v: unknown): v is string {
  return typeof v === "string" && DECIMAL_RE.test(v);
}
function isUint(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
}

function parseParams(value: unknown): ReceiptParamsJson | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const p = value as Record<string, unknown>;
  if (
    !isAddress(p.nftContract) ||
    !isDecimal(p.tokenId) ||
    !isHex32(p.resourceHash) ||
    !isHex32(p.policyHash) ||
    !isDecimal(p.licenseEpoch) ||
    !isDecimal(p.ownerEpochAtIssue) ||
    !isAddress(p.licensee) ||
    !isUint(p.permittedAction, 255) ||
    !isUint(p.transferMode, 1) ||
    !isUint(p.maxUses, 4_294_967_295) ||
    !isDecimal(p.expiresAt) ||
    !isHex32(p.purchaseRequestHash) ||
    !isHex32(p.paymentId) ||
    !isHex32(p.nonce) ||
    !isDecimal(p.issuedAt) ||
    !isDecimal(p.price) ||
    !isUint(p.creatorBps, 10_000) ||
    !isUint(p.ownerBps, 10_000)
  ) {
    return undefined;
  }
  return p as unknown as ReceiptParamsJson;
}

function toReceiptParams(p: ReceiptParamsJson): ReceiptParams {
  return {
    nftContract: p.nftContract,
    tokenId: BigInt(p.tokenId),
    resourceHash: p.resourceHash,
    policyHash: p.policyHash,
    licenseEpoch: BigInt(p.licenseEpoch),
    ownerEpochAtIssue: BigInt(p.ownerEpochAtIssue),
    licensee: p.licensee,
    permittedAction: p.permittedAction,
    transferMode: p.transferMode,
    maxUses: p.maxUses,
    expiresAt: BigInt(p.expiresAt),
    purchaseRequestHash: p.purchaseRequestHash,
    paymentId: p.paymentId,
    nonce: p.nonce,
    issuedAt: BigInt(p.issuedAt),
    price: BigInt(p.price),
    creatorBps: p.creatorBps,
    ownerBps: p.ownerBps,
  };
}

function parseJob(value: unknown): OperatorJob | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.idempotencyKey !== "string" || !KEY_RE.test(v.idempotencyKey)) {
    return undefined;
  }
  const idempotencyKey = v.idempotencyKey;
  switch (v.kind) {
    case "consume": {
      if (!isHex32(v.receiptHash) || !isUint(v.useIndex, 4_294_967_295))
        return undefined;
      return {
        kind: "consume",
        receiptHash: v.receiptHash,
        useIndex: v.useIndex,
        idempotencyKey,
      };
    }
    case "bumpLicenseEpoch": {
      if (!isDecimal(v.tokenId) || !isDecimal(v.fromEpoch)) return undefined;
      return {
        kind: "bumpLicenseEpoch",
        tokenId: BigInt(v.tokenId),
        fromEpoch: BigInt(v.fromEpoch),
        idempotencyKey,
      };
    }
    case "settleAndIssue": {
      const params = parseParams(v.params);
      if (params === undefined || !isDecimal(v.valueWeibar)) return undefined;
      return {
        kind: "settleAndIssue",
        params,
        valueWeibar: v.valueWeibar,
        idempotencyKey,
      };
    }
    case "finalize": {
      const params = parseParams(v.params);
      if (params === undefined || !isHex32(v.paymentId)) return undefined;
      return {
        kind: "finalize",
        paymentId: v.paymentId,
        params,
        idempotencyKey,
      };
    }
    default:
      return undefined;
  }
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
    clearNonce: async () => {
      await storage.delete(NONCE_KEY);
    },
    loadJob: (key) => storage.get<JobRecord>(`${JOB_PREFIX}${key}`),
    saveJob: (key, record) => storage.put(`${JOB_PREFIX}${key}`, record),
    readLicenseEpoch: (tokenId) => readLicenseEpoch(ctx(), tokenId),
    submit: (job, nonce) => {
      switch (job.kind) {
        case "consume":
          return submitConsume(ctx(), job.receiptHash, job.useIndex, { nonce });
        case "bumpLicenseEpoch":
          return submitBumpLicenseEpoch(ctx(), job.tokenId, { nonce });
        case "settleAndIssue":
          return submitSettleAndIssue(
            ctx(),
            toReceiptParams(job.params),
            BigInt(job.valueWeibar),
            { nonce },
          ).then((r) => r.txHash);
        case "finalize":
          return submitFinalize(
            ctx(),
            job.paymentId,
            toReceiptParams(job.params),
            { nonce },
          );
      }
    },
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
        "expected a consume / bumpLicenseEpoch / settleAndIssue / finalize job with an idempotencyKey",
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
