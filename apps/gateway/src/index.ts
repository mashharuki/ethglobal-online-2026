import type { JsonResponse } from "@truenft/openapi";
import { Hono } from "hono";
import { createDb } from "./db/client";
import type { Db } from "./db/types";
import { type Env, getChainId } from "./env";
import { handleError } from "./errors";
import { clientIp, rateLimit, walletOrIp } from "./middleware/rateLimit";

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

// Rate limits (spec 9.2, tasks.md T080): preview 60/min per IP; owner + keygate 30/min per
// wallet behind a 120/min per-IP brake (so wallet buckets cannot be minted without bound).
const MINUTE = 60_000;
app.use("/assets/*", rateLimit({ limit: 60, windowMs: MINUTE, key: clientIp }));
for (const prefix of ["/owner/*", "/keygate/*"]) {
  app.use(prefix, rateLimit({ limit: 120, windowMs: MINUTE, key: clientIp }));
  app.use(prefix, rateLimit({ limit: 30, windowMs: MINUTE, key: walletOrIp }));
}

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
