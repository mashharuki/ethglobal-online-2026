import { ErrorCode, isErrorCode } from "@truenft/shared";
import type { Address, Hex } from "viem";
import type { Env } from "../env";
import { AppError } from "../errors";
import type { OperatorJob } from "./operatorQueueCore";
import type { ConsumeOutcome } from "./receiptLockCore";

/**
 * Typed fetch wrappers for the two Durable Objects. Errors cross the DO boundary as the
 * openapi Error body and are re-raised as AppError so route handlers see one error model.
 */
type DoFailure = { ok: false; error: { code: string; message: string } };
type JsonResponse = { json(): Promise<unknown> };

async function parseDoResponse<T>(response: JsonResponse): Promise<T> {
  const body = (await response.json()) as ({ ok: true } & T) | DoFailure;
  if (body.ok) return body;
  if (isErrorCode(body.error.code)) {
    throw new AppError(ErrorCode[body.error.code], body.error.message);
  }
  throw new Error(`durable object failure: ${body.error.code}`);
}

const JSON_HEADERS = { "content-type": "application/json" };

export async function consumeViaReceiptLock(
  env: Env,
  input: { receiptHash: Hex; wallet: Address; retryUseIndex?: number },
): Promise<ConsumeOutcome> {
  const id = env.RECEIPT_LOCK.idFromName(input.receiptHash.toLowerCase());
  const response = await env.RECEIPT_LOCK.get(id).fetch(
    "https://receipt-lock/consume",
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input) },
  );
  return parseDoResponse<ConsumeOutcome>(response);
}

export async function submitViaOperatorQueue(
  env: Env,
  job: OperatorJob,
): Promise<Hex> {
  const id = env.OPERATOR_TX_QUEUE.idFromName("operator");
  const response = await env.OPERATOR_TX_QUEUE.get(id).fetch(
    "https://operator-queue/submit",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(job, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    },
  );
  const body = await parseDoResponse<{ txHash: Hex }>(response);
  return body.txHash;
}
