import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/**
 * OperatorTxQueue - single instance (`idFromName("operator")`).
 * Allocates operator-key nonces sequentially so concurrent ReceiptLocks never collide
 * (research.md R-3a). Implemented in tasks.md T083; this is the binding skeleton.
 */
export class OperatorTxQueue extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    return Response.json(
      {
        code: "NOT_IMPLEMENTED",
        message: "OperatorTxQueue is implemented in T083",
      },
      { status: 501 },
    );
  }
}
