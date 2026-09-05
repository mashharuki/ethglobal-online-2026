import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/**
 * ReceiptLock - one instance per `receiptHash` (`idFromName(receiptHash)`).
 * Serializes Receipt consumption so exactly one `useIndex` is settled per request
 * (research.md R-3 / R-3a). Implemented in tasks.md T083; this is the binding skeleton.
 */
export class ReceiptLock extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    return Response.json(
      {
        code: "NOT_IMPLEMENTED",
        message: "ReceiptLock is implemented in T083",
      },
      { status: 501 },
    );
  }
}
