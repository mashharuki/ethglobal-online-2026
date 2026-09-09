import type { JsonResponse } from "@truenft/openapi";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuthzDb, createDb } from "./db/client";
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

// CORS must run before database/service setup so browser preflight requests return without
// opening Hyperdrive connections. Reflect only explicitly configured origins; the API carries
// wallet signatures and payment payloads, so a wildcard origin would be unnecessarily broad.
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = c.env.CORS_ALLOWED_ORIGINS.split(",").map(
        (value: string) => value.trim(),
      );
      return allowed.includes(origin) ? origin : undefined;
    },
    allowMethods: ["GET", "HEAD", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-PAYMENT"],
    exposeHeaders: ["Mcp-Session-Id", "X-PAYMENT-RESPONSE"],
    maxAge: 86_400,
  }),
);

// Two Hyperdrive-backed drizzle handles per request (postgres.js connects lazily on the
// first query, so routes that never touch Postgres - /healthz - open no connections). `authzDb`
// goes through the cache-disabled HYPERDRIVE_AUTHZ binding - authorization-critical reads
// (agent_grant, agent_wallet_binding, oauth_token, mcp_authenticated_session) must use it
// instead of `db` (test/node/authzHandle.test.ts enforces this at the call-site level).
app.use("*", async (c, next) => {
  const handle = createDb(c.env);
  const authzHandle = createAuthzDb(c.env);
  c.set("db", handle.db);
  c.set("authzDb", authzHandle.db);
  c.set("services", createServices(c.env, handle.db));
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(handle.close());
    c.executionCtx.waitUntil(authzHandle.close());
  }
});

// Rate limits (spec 9.2, tasks.md T080): preview 60/min per IP; owner + keygate 30/min per
// wallet behind a 120/min per-IP brake (so wallet buckets cannot be minted without bound).
const MINUTE = 60_000;
app.use("/assets/*", rateLimit({ limit: 60, windowMs: MINUTE, key: clientIp }));
app.use("/mcp", rateLimit({ limit: 60, windowMs: MINUTE, key: clientIp }));
// DCR (Codex review, Phase 6a) is deliberately unauthenticated (that's the point of dynamic
// registration) - without a rate limit, an unauthenticated caller could grow oauth_client
// without bound.
app.use(
  "/oauth/register",
  rateLimit({ limit: 20, windowMs: MINUTE, key: clientIp }),
);
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
