import { DurableObject } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { createChainContext } from "../chain/clients";
import { readIsConsumed, readReceiptStatus } from "../chain/reads";
import { waitForTx } from "../chain/writes";
import { createDb, type DbHandle } from "../db/client";
import { receiptConsumption } from "../db/schema";
import { isUniqueViolation } from "../db/types";
import type { Env } from "../env";
import { submitViaOperatorQueue } from "./client";
import {
  type ConsumptionRow,
  type LockPorts,
  ReceiptLockCore,
} from "./receiptLockCore";
import { doErrorResponse, doFailure } from "./respond";

/**
 * ReceiptLock Durable Object (tasks.md T083): one instance per receiptHash
 * (`idFromName(receiptHash)`). All decision logic lives in ReceiptLockCore; this class only
 * binds it to the chain (eth_call authority), Hyperdrive Postgres and the OperatorTxQueue.
 */
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type ConsumeBody = {
  receiptHash: Hex;
  wallet: Address;
  retryUseIndex?: number;
};

function parseBody(value: unknown): ConsumeBody | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { receiptHash, wallet, retryUseIndex } = value as Record<
    string,
    unknown
  >;
  if (typeof receiptHash !== "string" || !HEX32.test(receiptHash))
    return undefined;
  if (typeof wallet !== "string" || !ADDRESS.test(wallet)) return undefined;
  if (
    retryUseIndex !== undefined &&
    (typeof retryUseIndex !== "number" ||
      !Number.isInteger(retryUseIndex) ||
      retryUseIndex < 0)
  ) {
    return undefined;
  }
  return {
    receiptHash: receiptHash as Hex,
    wallet: wallet as Address,
    retryUseIndex: retryUseIndex as number | undefined,
  };
}

function createLockPorts(env: Env, handle: DbHandle): LockPorts {
  const ctx = createChainContext(env);
  const db = handle.db;
  const toRow = (
    r: typeof receiptConsumption.$inferSelect,
  ): ConsumptionRow => ({
    receiptHash: r.receiptHash,
    useIndex: r.useIndex,
    wallet: r.wallet as Address,
    status: r.status,
    onchainTx: r.onchainTx,
    settledAt: r.settledAt,
    createdAt: r.createdAt,
  });
  return {
    now: () => new Date(),
    readReceipt: async (receiptHash) => {
      const s = await readReceiptStatus(ctx, receiptHash);
      return {
        issued: s.issued,
        maxUses: s.maxUses,
        usedCount: s.usedCount,
        expiresAt: s.expiresAt,
      };
    },
    readIsConsumed: (receiptHash, useIndex) =>
      readIsConsumed(ctx, receiptHash, useIndex),
    listRows: async (receiptHash) =>
      (
        await db
          .select()
          .from(receiptConsumption)
          .where(eq(receiptConsumption.receiptHash, receiptHash))
      ).map(toRow),
    insertLocked: async (receiptHash, useIndex, wallet) => {
      try {
        await db.insert(receiptConsumption).values({
          receiptHash,
          useIndex,
          wallet,
          status: "locked",
        });
        return true;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },
    updateStatus: async (receiptHash, useIndex, patch) => {
      await db
        .update(receiptConsumption)
        .set({
          status: patch.status,
          onchainTx: patch.onchainTx,
          settledAt: patch.settledAt,
          ...(patch.relock === undefined
            ? {}
            : {
                wallet: patch.relock.wallet,
                createdAt: patch.relock.createdAt,
              }),
        })
        .where(
          and(
            eq(receiptConsumption.receiptHash, receiptHash),
            eq(receiptConsumption.useIndex, useIndex),
          ),
        );
    },
    submitConsume: (receiptHash, useIndex) =>
      submitViaOperatorQueue(env, { kind: "consume", receiptHash, useIndex }),
    waitForTx: async (txHash) => {
      await waitForTx(ctx, txHash, "consume");
    },
  };
}

export class ReceiptLock extends DurableObject<Env> {
  private core: ReceiptLockCore | undefined;
  private handle: DbHandle | undefined;

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return doFailure("METHOD_NOT_ALLOWED", "POST only", 405);
    }
    let body: ConsumeBody | undefined;
    try {
      body = parseBody(await request.json());
    } catch {
      body = undefined;
    }
    if (body === undefined) {
      return doFailure(
        "BAD_REQUEST",
        "expected {receiptHash, wallet, retryUseIndex?}",
        400,
      );
    }
    this.handle ??= createDb(this.env);
    this.core ??= new ReceiptLockCore(createLockPorts(this.env, this.handle));
    try {
      const outcome = await this.core.consume(body);
      return Response.json({ ok: true, ...outcome });
    } catch (error) {
      return doErrorResponse(error, "ReceiptLock");
    }
  }
}
