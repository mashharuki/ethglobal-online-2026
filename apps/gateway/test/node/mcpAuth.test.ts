import type { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentGrant,
  agentWalletBinding,
  oauthToken,
} from "../../src/db/schema";
import type { AuthzDb, Db } from "../../src/db/types";
import type { Env } from "../../src/env";
import { handleError } from "../../src/errors";
import {
  assertSessionMatchesPrincipal,
  extractBearerToken,
  openAuthenticatedSession,
  requireMcpAuth,
} from "../../src/mcp/auth";
import { sessionKey } from "../../src/mcp/session";
import {
  generateOpaqueValue,
  hashOpaqueValue,
} from "../../src/oauth/tokenHash";
import { type AppEnv, registerRoutes } from "../../src/routes";
import type { Services } from "../../src/services";
import { buildServices, createFake, type Fake, NOW } from "./fakeServices";
import {
  buildAsset,
  createTestDb,
  MemoryKv,
  makeEnv,
  type TestAsset,
} from "./helpers";

/**
 * MCP Bearer-token authentication (tasks.md Phase 7, specs/mcp-auth-remediation-plan.md §7):
 * mcp/auth.ts's own live-re-derivation logic (unit tests), then the actual wiring of
 * `withScope` (server.ts) through `/mcp` (routes/mcp.ts) under both settings of the
 * MCP_AUTH_REQUIRED cutover flag.
 */

let nextWalletAddressSeed = 1;

async function seedGrantWithAccessToken(
  db: AuthzDb,
  overrides: {
    scope?: string;
    revokeGrant?: boolean;
    grantExpiresAt?: Date;
    tokenKind?: "access" | "refresh";
    tokenExpiresAt?: Date;
    tokenRevokedAt?: Date | null;
  } = {},
): Promise<{
  token: string;
  grantId: string;
  walletId: string;
  principalId: string;
  clientId: string;
  scope: string;
}> {
  const scope = overrides.scope ?? "assets:read access:buy";
  const principalId = `did:privy:mcp-auth-test-${crypto.randomUUID()}`;
  const walletId = crypto.randomUUID();
  const clientId = `client-mcp-auth-test-${crypto.randomUUID()}`;
  const addressSeed = nextWalletAddressSeed++;
  await db.insert(agentWalletBinding).values({
    id: walletId,
    principalId,
    purpose: "mcp-agent",
    chainType: "ethereum",
    chainId: 296,
    delegationShape: "additional-signer",
    externalId: `aiwallet-mcp-auth-test-${walletId}`,
    provisioningKey: `aiwallet:v1:mcp-auth-test:${walletId}`,
    provisioningState: "active",
    privyWalletId: `privy-${walletId}`,
    address: `0x${String(addressSeed).padStart(40, "0")}`,
    signerQuorumId: "quorum-1",
    signerState: "attached",
    ownerVerifiedAt: NOW,
  });
  const grantId = crypto.randomUUID();
  await db.insert(agentGrant).values({
    id: grantId,
    principalId,
    walletId,
    clientId,
    scope,
    chainId: 296,
    expiresAt: overrides.grantExpiresAt ?? new Date(NOW.getTime() + 3_600_000),
    totalBudgetTinybar: 10_000_000n,
    maxPerPurchaseTinybar: 1_000_000n,
    ...(overrides.revokeGrant
      ? { state: "revoked" as const, revokedAt: NOW, revokedReason: "test" }
      : {}),
  });
  const token = generateOpaqueValue();
  await db.insert(oauthToken).values({
    tokenHash: hashOpaqueValue(token),
    kind: overrides.tokenKind ?? "access",
    grantId,
    clientId,
    principalId,
    scope,
    resource: "https://gateway.example/mcp",
    expiresAt: overrides.tokenExpiresAt ?? new Date(NOW.getTime() + 3_600_000),
    revokedAt: overrides.tokenRevokedAt ?? null,
  });
  return { token, grantId, walletId, principalId, clientId, scope };
}

describe("mcp/auth.ts", () => {
  let db: AuthzDb;
  let client: PGlite;

  beforeEach(async () => {
    const handle = await createTestDb();
    db = handle.db as unknown as AuthzDb;
    client = handle.client;
  });

  afterEach(async () => {
    await client.close();
  });

  describe("extractBearerToken", () => {
    it("extracts the token from a well-formed header", () => {
      expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    });

    it("returns undefined for missing, malformed or empty values", () => {
      expect(extractBearerToken(undefined)).toBeUndefined();
      expect(extractBearerToken(null)).toBeUndefined();
      expect(extractBearerToken("")).toBeUndefined();
      expect(extractBearerToken("Basic abc123")).toBeUndefined();
      expect(extractBearerToken("Bearer")).toBeUndefined();
      expect(extractBearerToken("Bearer ")).toBeUndefined();
      expect(extractBearerToken("bearer abc123")).toBeUndefined(); // case-sensitive prefix
    });
  });

  describe("requireMcpAuth", () => {
    it("rejects with AUTH_TOKEN_INVALID when the header is missing", async () => {
      await expect(requireMcpAuth(db, undefined, NOW)).rejects.toMatchObject({
        code: "AUTH_TOKEN_INVALID",
      });
    });

    it("rejects with AUTH_TOKEN_INVALID for an unknown token", async () => {
      await expect(
        requireMcpAuth(db, "Bearer nonexistent-token", NOW),
      ).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    });

    it("rejects with AUTH_TOKEN_INVALID for a refresh token presented as a bearer access token", async () => {
      const { token } = await seedGrantWithAccessToken(db, {
        tokenKind: "refresh",
      });
      await expect(
        requireMcpAuth(db, `Bearer ${token}`, NOW),
      ).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    });

    it("rejects with AUTH_TOKEN_INVALID for a revoked token", async () => {
      const { token } = await seedGrantWithAccessToken(db, {
        tokenRevokedAt: NOW,
      });
      await expect(
        requireMcpAuth(db, `Bearer ${token}`, NOW),
      ).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    });

    it("rejects with AUTH_TOKEN_INVALID for an expired token", async () => {
      const { token } = await seedGrantWithAccessToken(db, {
        tokenExpiresAt: new Date(NOW.getTime() - 1000),
      });
      await expect(
        requireMcpAuth(db, `Bearer ${token}`, NOW),
      ).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    });

    it("returns the live principal for a valid token", async () => {
      const seeded = await seedGrantWithAccessToken(db, {});
      const principal = await requireMcpAuth(db, `Bearer ${seeded.token}`, NOW);
      expect(principal).toEqual({
        principalId: seeded.principalId,
        grantId: seeded.grantId,
        walletId: seeded.walletId,
        clientId: seeded.clientId,
        scope: seeded.scope,
      });
    });

    // Positive control (CLAUDE.md "足したガードには陽性対照を取る"): the whole point of this
    // guard is that a token which is itself still perfectly valid must still fail once the
    // grant behind it is revoked (Constitution Principle II - live re-derivation, never
    // cached). Manually reverting the `assertGrantUsable` call in auth.ts and re-running this
    // test turns it red (the call above resolves instead of rejecting) - confirming the guard
    // actually fires, not just that the code compiles.
    it("rejects with DELEGATION_REVOKED when the grant was revoked after the token was minted", async () => {
      const seeded = await seedGrantWithAccessToken(db, {});
      await db
        .update(agentGrant)
        .set({ state: "revoked", revokedAt: NOW })
        .where(eq(agentGrant.id, seeded.grantId));
      await expect(
        requireMcpAuth(db, `Bearer ${seeded.token}`, NOW),
      ).rejects.toMatchObject({ code: "DELEGATION_REVOKED" });
    });

    it("rejects with DELEGATION_EXPIRED when the grant itself expired even though the token has not", async () => {
      const seeded = await seedGrantWithAccessToken(db, {});
      await db
        .update(agentGrant)
        .set({ expiresAt: new Date(NOW.getTime() - 1000) })
        .where(eq(agentGrant.id, seeded.grantId));
      await expect(
        requireMcpAuth(db, `Bearer ${seeded.token}`, NOW),
      ).rejects.toMatchObject({ code: "DELEGATION_EXPIRED" });
    });
  });

  describe("openAuthenticatedSession / assertSessionMatchesPrincipal", () => {
    it("binds a session key to a principal so a later call can verify it", async () => {
      const seeded = await seedGrantWithAccessToken(db, {});
      const principal = await requireMcpAuth(db, `Bearer ${seeded.token}`, NOW);
      const key = sessionKey("session-bind-1");
      await openAuthenticatedSession(db, key, principal, NOW);
      await expect(
        assertSessionMatchesPrincipal(db, key, principal),
      ).resolves.toBeUndefined();
    });

    it("is idempotent: a second open for the same session key does not rebind the principal", async () => {
      const a = await seedGrantWithAccessToken(db, {});
      const principalA = await requireMcpAuth(db, `Bearer ${a.token}`, NOW);
      const b = await seedGrantWithAccessToken(db, {});
      const principalB = await requireMcpAuth(db, `Bearer ${b.token}`, NOW);
      const key = sessionKey("session-bind-2");
      await openAuthenticatedSession(db, key, principalA, NOW);
      await openAuthenticatedSession(db, key, principalB, NOW); // no-op, first binding wins
      await expect(
        assertSessionMatchesPrincipal(db, key, principalA),
      ).resolves.toBeUndefined();
      await expect(
        assertSessionMatchesPrincipal(db, key, principalB),
      ).rejects.toMatchObject({ code: "MCP_SESSION_MISMATCH" });
    });

    it("rejects with MCP_SESSION_MISMATCH when no session was ever opened for that key", async () => {
      const seeded = await seedGrantWithAccessToken(db, {});
      const principal = await requireMcpAuth(db, `Bearer ${seeded.token}`, NOW);
      await expect(
        assertSessionMatchesPrincipal(
          db,
          sessionKey("never-opened"),
          principal,
        ),
      ).rejects.toMatchObject({ code: "MCP_SESSION_MISMATCH" });
    });

    it("rejects with MCP_SESSION_MISMATCH for a different principal on the same session key", async () => {
      const a = await seedGrantWithAccessToken(db, {});
      const principalA = await requireMcpAuth(db, `Bearer ${a.token}`, NOW);
      const b = await seedGrantWithAccessToken(db, {});
      const principalB = await requireMcpAuth(db, `Bearer ${b.token}`, NOW);
      const key = sessionKey("session-bind-3");
      await openAuthenticatedSession(db, key, principalA, NOW);
      await expect(
        assertSessionMatchesPrincipal(db, key, principalB),
      ).rejects.toMatchObject({ code: "MCP_SESSION_MISMATCH" });
    });
  });
});

describe("/mcp scope gating (Phase 7, withScope + MCP_ENABLED/MCP_AUTH_REQUIRED)", () => {
  let db: Db;
  let authzDb: AuthzDb;
  let client: PGlite;
  let env: Env;
  let asset: TestAsset;
  let app: Hono<AppEnv>;
  let fake: Fake;
  let services: Services;

  async function setup(envOverrides: Partial<Env>): Promise<void> {
    const handle = await createTestDb();
    db = handle.db;
    authzDb = handle.db as unknown as AuthzDb;
    client = handle.client;
    asset = buildAsset("b7");
    env = await makeEnv(new MemoryKv(), [asset], envOverrides);
    fake = createFake();
    services = buildServices({ db, env, asset, fake });
    app = new Hono<AppEnv>();
    app.onError(handleError);
    app.use("*", async (c, next) => {
      c.set("db", db);
      c.set("authzDb", authzDb);
      c.set("services", services);
      await next();
    });
    registerRoutes(app);
  }

  afterEach(async () => {
    await client.close();
  });

  async function connectWithAuth(token?: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(
      new URL("http://gateway.test/mcp"),
      {
        fetch: async (url, init) =>
          app.request(String(url), init as RequestInit),
        ...(token === undefined
          ? {}
          : { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
      },
    );
    const mcp = new Client({ name: "mcp-auth-scope-test", version: "0.0.0" });
    await mcp.connect(transport);
    return mcp;
  }

  async function call(
    mcp: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; body: Record<string, unknown> }> {
    const result = (await mcp.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    const text = result.content.find((c) => c.type === "text")?.text ?? "{}";
    return {
      isError: result.isError === true,
      body: JSON.parse(text) as Record<string, unknown>,
    };
  }

  it("answers 404 for /mcp when MCP_ENABLED=false", async () => {
    await setup({ MCP_ENABLED: "false" });
    const res = await app.request("http://gateway.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    expect(res.status).toBe(404);
  });

  it("keeps discover_assets working with no Authorization header even when MCP_AUTH_REQUIRED=true", async () => {
    await setup({ MCP_AUTH_REQUIRED: "true" });
    const mcp = await connectWithAuth();
    const result = await call(mcp, "discover_assets", {});
    expect(result.isError).toBe(false);
    await mcp.close();
  });

  it("refuses buy_access with AUTH_TOKEN_INVALID when MCP_AUTH_REQUIRED=true and no token is presented", async () => {
    await setup({ MCP_AUTH_REQUIRED: "true" });
    const mcp = await connectWithAuth();
    const result = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(result).toMatchObject({
      isError: true,
      body: { code: "AUTH_TOKEN_INVALID" },
    });
    expect(fake.settleCalls).toBe(0);
    await mcp.close();
  });

  it("refuses buy_access with INSUFFICIENT_SCOPE when the presented token lacks access:buy", async () => {
    await setup({ MCP_AUTH_REQUIRED: "true" });
    const { token } = await seedGrantWithAccessToken(authzDb, {
      scope: "assets:read",
    });
    const mcp = await connectWithAuth(token);
    const result = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(result).toMatchObject({
      isError: true,
      body: { code: "INSUFFICIENT_SCOPE" },
    });
    expect(fake.settleCalls).toBe(0);
    await mcp.close();
  });

  it("allows buy_access with a valid token carrying access:buy", async () => {
    await setup({ MCP_AUTH_REQUIRED: "true" });
    const { token } = await seedGrantWithAccessToken(authzDb, {});
    const mcp = await connectWithAuth(token);
    const result = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(result.isError).toBe(false);
    expect(fake.settleCalls).toBe(1);
    await mcp.close();
  });

  it("still lets buy_access through with no token while MCP_AUTH_REQUIRED=false (pre-Phase-10 default)", async () => {
    await setup({ MCP_AUTH_REQUIRED: "false" });
    const mcp = await connectWithAuth();
    const result = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(result.isError).toBe(false);
    expect(fake.settleCalls).toBe(1);
    await mcp.close();
  });

  it("still enforces scope for a token that WAS presented even while MCP_AUTH_REQUIRED=false", async () => {
    await setup({ MCP_AUTH_REQUIRED: "false" });
    const { token } = await seedGrantWithAccessToken(authzDb, {
      scope: "assets:read",
    });
    const mcp = await connectWithAuth(token);
    const result = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(result).toMatchObject({
      isError: true,
      body: { code: "INSUFFICIENT_SCOPE" },
    });
    expect(fake.settleCalls).toBe(0);
    await mcp.close();
  });
});
