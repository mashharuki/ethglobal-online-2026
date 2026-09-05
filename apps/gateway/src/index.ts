import type { JsonResponse } from "@truenft/openapi";
import { Hono } from "hono";
import { type Env, getChainId } from "./env";

/**
 * Access Gateway entrypoint. Routes are mounted here as they are implemented
 * (tasks.md Phase 7). Handler I/O is typed with the openapi-generated `paths`.
 */
const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => {
  const body: JsonResponse<"/healthz", "get"> = {
    ok: true,
    chainId: getChainId(c.env),
  };
  return c.json(body);
});

export default app;

// Durable Object classes must be exported from the Worker entry module.
export { OperatorTxQueue } from "./do/OperatorTxQueue";
export { ReceiptLock } from "./do/ReceiptLock";
