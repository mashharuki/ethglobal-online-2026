import type { JsonResponse } from "@truenft/openapi";
import { Hono } from "hono";
import { createDb } from "./db/client";
import { getChainId } from "./env";
import { handleError } from "./errors";
import { clientIp, rateLimit, walletOrIp } from "./middleware/rateLimit";
import { type AppEnv, registerRoutes } from "./routes";
import { createServices } from "./services";

/**
 * Access Gateway entrypoint (tasks.md T069). Every request gets a Hyperdrive-backed drizzle
 * handle and a Services bundle (chain reads via viem, Durable Objects, facilitator); routes
 * are typed with the openapi-generated `paths` and every error goes through `handleError`.
 */
const app = new Hono<AppEnv>();

app.onError(handleError);
app.notFound((c) => c.json({ error: "not_found" }, 404));

// One Hyperdrive-backed drizzle handle per request (postgres.js connects lazily on the
// first query, so routes that never touch Postgres - /healthz - open no connection).
app.use("*", async (c, next) => {
  const handle = createDb(c.env);
  c.set("db", handle.db);
  c.set("services", createServices(c.env, handle.db));
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

registerRoutes(app);

export default app;

// Durable Object classes must be exported from the Worker entry module.
export { OperatorTxQueue } from "./do/OperatorTxQueue";
export { ReceiptLock } from "./do/ReceiptLock";
