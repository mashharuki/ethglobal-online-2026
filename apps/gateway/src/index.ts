import type { JsonResponse } from "@truenft/openapi";
import { Hono } from "hono";
import { createDb } from "./db/client";
import type { Db } from "./db/types";
import { type Env, getChainId } from "./env";
import { handleError } from "./errors";

/**
 * Access Gateway entrypoint (tasks.md T069). Routes are mounted here as they are
 * implemented (Phase 7). Handler I/O is typed with the openapi-generated `paths`;
 * every error goes through `handleError` so clients always get the openapi Error body.
 */
export type AppEnv = { Bindings: Env; Variables: { db: Db } };

const app = new Hono<AppEnv>();

app.onError(handleError);
app.notFound((c) => c.json({ error: "not_found" }, 404));

// One Hyperdrive-backed drizzle handle per request (postgres.js connects lazily on the
// first query, so routes that never touch Postgres - /healthz - open no connection).
app.use("*", async (c, next) => {
  const handle = createDb(c.env);
  c.set("db", handle.db);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(handle.close());
  }
});

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
