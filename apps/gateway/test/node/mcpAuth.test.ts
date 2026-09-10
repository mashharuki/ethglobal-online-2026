import { generateKeyPairSync } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentGrant,
  agentWalletBinding,
  oauthToken,
} from "../../src/db/schema";
import type { AuthzDb, Db } from "../../src/db/types";
import type { Env } from "../../src/env";
import { AppError, handleError } from "../../src/errors";
import {
  assertSessionMatchesPrincipal,
  attemptMcpAuth,
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
import {
  buildServices,
  buyer,
  createFake,
  type Fake,
  NOW,
} from "./fakeServices";
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

/**
 * Real signable local accounts, one per fake "Privy wallet" this suite seeds
 * (seedGrantWithAccessToken), keyed by privyWalletId. fakeDelegatedWalletFetch signs through
 * the matching account for real, so buyAccess.ts's ECDSA public-key recovery
 * (mcp/hedera.ts's recoverWalletPublicKey, which needs a mathematically valid signature, not
 * an arbitrary string) succeeds exactly as it would against the real Privy API. Cleared in
 * setup() at the start of every test.
 */
const delegatedAccountsByPrivyWalletId = new Map<
  string,
  ReturnType<typeof privateKeyToAccount>
>();

// A P-256 PKCS8 private key, generated fresh per test run (privyClient.test.ts's own pattern -
// a static literal here would be a real, valid private key checked into git history).
const PRIVY_AUTHORIZATION_PRIVATE_KEY = generateKeyPairSync("ec", {
  namedCurve: "P-256",
})
  .privateKey.export({ type: "pkcs8", format: "der" })
  .toString("base64");

const PRIVY_DELEGATION_ENV: Partial<Env> = {
  PRIVY_APP_ID: "app-id",
  PRIVY_APP_SECRET: "app-secret",
  PRIVY_AUTHORIZATION_PRIVATE_KEY,
  PRIVY_SIGNER_QUORUM_ID: "quorum-1",
  PRIVY_AI_WALLET_EXTERNAL_ID_PREFIX: "aiwallet-mcp-auth-test",
};

const FAKE_MIRROR_URL = "https://mirror.invalid";

/**
 * The env this suite's authenticated tests need in addition to PRIVY_DELEGATION_ENV:
 * resolveAgentWallet (mcp/context.ts) resolves the delegated wallet's Hedera account by
 * calling resolveAgentAccountId -> resolveHederaAccount directly (unlike the shared-wallet
 * path, which fakeServices.ts's `agent.accountId()` fakes outright) - so this suite's global
 * fetch stub must also answer that mirror-node lookup, for real, not just Privy's RPC.
 */
const MIRROR_ACCOUNT_ENV: Partial<Env> = {
  HEDERA_MIRROR_URL: FAKE_MIRROR_URL,
  MCP_BALANCE_HEADROOM_TINYBAR: "1000000",
};

type PrivyRpcBody = { method: string; params: Record<string, unknown> };
type PrivyTypedDataParams = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primary_type: string;
  message: Record<string, unknown>;
};

/**
 * Stubbed at the HTTP boundary (privyClient.test.ts's own pattern), not by mocking
 * mcp/privyClient.ts - these route-level tests exercise the real @privy-io/node request
 * wiring through mcp/context.ts's `resolveAgentWallet`. Serves POST /v1/wallets/{id}/rpc
 * (Privy signing) for whichever privyWalletId is in delegatedAccountsByPrivyWalletId, and GET
 * {FAKE_MIRROR_URL}/api/v1/accounts/{address} (resolveAgentAccountId's own dependency,
 * mcp/hedera.ts) with a fixed funded/keyed account for any address queried.
 */
function fakeDelegatedWalletFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(`${FAKE_MIRROR_URL}/api/v1/accounts/`)) {
      return new Response(
        JSON.stringify({
          account: "0.0.777",
          key: { key: "aa".repeat(32) },
          balance: { balance: 100_000_000_000 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const match = /\/v1\/wallets\/([^/]+)\/rpc$/.exec(url);
    if (match?.[1] === undefined) {
      throw new Error(`unexpected fetch in test: ${url}`);
    }
    const account = delegatedAccountsByPrivyWalletId.get(match[1]);
    if (account === undefined) {
      throw new Error(`no fake delegated account registered for ${match[1]}`);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as PrivyRpcBody;
    let signature: Hex;
    if (body.method === "secp256k1_sign") {
      signature = await account.sign({ hash: body.params.hash as Hex });
    } else if (body.method === "eth_signTypedData_v4") {
      const td = body.params.typed_data as PrivyTypedDataParams;
      signature = await account.signTypedData({
        domain: td.domain,
        types: td.types,
        primaryType: td.primary_type,
        message: td.message,
      } as unknown as Parameters<typeof account.signTypedData>[0]);
    } else {
      throw new Error(`unexpected Privy rpc method in test: ${body.method}`);
    }
    return new Response(
      JSON.stringify({
        method: body.method,
        data: { encoding: "hex", signature },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

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
  walletAddress: Address;
}> {
  const scope = overrides.scope ?? "assets:read access:buy";
  const principalId = `did:privy:mcp-auth-test-${crypto.randomUUID()}`;
  const walletId = crypto.randomUUID();
  const privyWalletId = `privy-${walletId}`;
  const clientId = `client-mcp-auth-test-${crypto.randomUUID()}`;
  const addressSeed = nextWalletAddressSeed++;
  const account = privateKeyToAccount(
    `0x${addressSeed.toString(16).padStart(2, "0").repeat(32)}` as Hex,
  );
  delegatedAccountsByPrivyWalletId.set(privyWalletId, account);
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
    privyWalletId,
    address: account.address,
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
  return {
    token,
    grantId,
    walletId,
    principalId,
    clientId,
    scope,
    walletAddress: account.address,
  };
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

    // Codex review, Phase 7: auth-scheme tokens are case-insensitive (RFC 7235 §2.1) - real
    // clients send "bearer"/"BEARER" as often as "Bearer".
    it("matches the Bearer scheme case-insensitively", () => {
      expect(extractBearerToken("bearer abc123")).toBe("abc123");
      expect(extractBearerToken("BEARER abc123")).toBe("abc123");
      expect(extractBearerToken("BeArEr abc123")).toBe("abc123");
    });

    it("returns undefined for missing, malformed or empty values", () => {
      expect(extractBearerToken(undefined)).toBeUndefined();
      expect(extractBearerToken(null)).toBeUndefined();
      expect(extractBearerToken("")).toBeUndefined();
      expect(extractBearerToken("Basic abc123")).toBeUndefined();
      expect(extractBearerToken("Bearer")).toBeUndefined();
      expect(extractBearerToken("Bearer ")).toBeUndefined();
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

  // Codex review, Phase 7: attemptMcpAuth must distinguish "no header" from "header present
  // but rejected" - collapsing both into the same result let a caller present a garbage token
  // and silently fall back to legacy unauthenticated access instead of being refused.
  describe("attemptMcpAuth", () => {
    it("returns kind:none when there is no Authorization header", async () => {
      await expect(attemptMcpAuth(db, undefined, NOW)).resolves.toEqual({
        kind: "none",
      });
      await expect(attemptMcpAuth(db, null, NOW)).resolves.toEqual({
        kind: "none",
      });
    });

    it("returns kind:failed (never kind:none) for a presented-but-invalid token", async () => {
      await expect(
        attemptMcpAuth(db, "Bearer nonexistent-token", NOW),
      ).resolves.toEqual({ kind: "failed" });
      const { token } = await seedGrantWithAccessToken(db, {
        tokenRevokedAt: NOW,
      });
      await expect(attemptMcpAuth(db, `Bearer ${token}`, NOW)).resolves.toEqual(
        { kind: "failed" },
      );
    });

    it("returns kind:failed for a valid token whose grant was revoked", async () => {
      const seeded = await seedGrantWithAccessToken(db, {});
      await db
        .update(agentGrant)
        .set({ state: "revoked", revokedAt: NOW })
        .where(eq(agentGrant.id, seeded.grantId));
      await expect(
        attemptMcpAuth(db, `Bearer ${seeded.token}`, NOW),
      ).resolves.toEqual({ kind: "failed" });
    });

    it("returns kind:authenticated with the live principal for a valid token", async () => {
      const seeded = await seedGrantWithAccessToken(db, {});
      await expect(
        attemptMcpAuth(db, `Bearer ${seeded.token}`, NOW),
      ).resolves.toEqual({
        kind: "authenticated",
        principal: {
          principalId: seeded.principalId,
          grantId: seeded.grantId,
          walletId: seeded.walletId,
          clientId: seeded.clientId,
          scope: seeded.scope,
        },
      });
    });

    it("rethrows a genuine infra failure instead of masking it as a failed auth attempt", async () => {
      const handle = await createTestDb();
      const isolatedDb = handle.db as unknown as AuthzDb;
      const seeded = await seedGrantWithAccessToken(isolatedDb, {});
      await handle.client.close();
      let caught: unknown;
      try {
        await attemptMcpAuth(isolatedDb, `Bearer ${seeded.token}`, NOW);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(caught).not.toBeInstanceOf(AppError);
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
    delegatedAccountsByPrivyWalletId.clear();
    // Always present: harmless for a test that never authenticates (resolveAgentWallet,
    // mcp/context.ts, only ever reaches createPrivyDelegationClient when
    // ctx.auth.kind === "authenticated"), and needed by every test in this block that DOES.
    vi.stubGlobal("fetch", fakeDelegatedWalletFetch());
    const handle = await createTestDb();
    db = handle.db;
    authzDb = handle.db as unknown as AuthzDb;
    client = handle.client;
    asset = buildAsset("b7");
    env = await makeEnv(new MemoryKv(), [asset], {
      ...PRIVY_DELEGATION_ENV,
      ...MIRROR_ACCOUNT_ENV,
      ...envOverrides,
    });
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
    vi.unstubAllGlobals();
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

  it("allows buy_access with a valid token carrying access:buy, and signs as the principal's OWN delegated wallet - not the shared one", async () => {
    await setup({ MCP_AUTH_REQUIRED: "true" });
    const { token, walletAddress } = await seedGrantWithAccessToken(
      authzDb,
      {},
    );
    fake.payerAccount = "0.0.777"; // matches fakeDelegatedWalletFetch's mirror-account response
    fake.payerEvm = walletAddress;
    const mcp = await connectWithAuth(token);
    const result = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(result.isError).toBe(false);
    expect(fake.settleCalls).toBe(1);
    // specs/mcp-auth-remediation-plan.md's completion condition, the narrowest form of it:
    // an authenticated purchase's licensee is the CALLER's own delegated wallet
    // (agent_wallet_binding.address), never the single shared wallet every unauthenticated
    // caller still gets (fake.agentWallet.address, == buyer.address by fakeServices.ts's own
    // fixture design) - see the next test for the full two-principals form of this.
    expect(
      (result.body.receipt as { licensee: string }).licensee.toLowerCase(),
    ).toBe(walletAddress.toLowerCase());
    expect(
      (result.body.receipt as { licensee: string }).licensee.toLowerCase(),
    ).not.toBe(buyer.address.toLowerCase());
    await mcp.close();
  });

  it("gives two different authenticated principals two different licensee addresses on their purchased receipts", async () => {
    // This is specs/mcp-auth-remediation-plan.md's own stated completion condition for the
    // entire remediation, in its most direct form: buyAccess.ts used to call
    // services.agent.wallet() unconditionally (the single shared wallet, mcp/wallet.ts) even
    // once withScope started gating WHO could call it - authenticated or not, every buyer
    // ended up as the same licensee. mcp/context.ts's resolveAgentWallet is what actually
    // fixes that, and this is the test that would have caught it never being wired.
    await setup({ MCP_AUTH_REQUIRED: "true" });
    const userA = await seedGrantWithAccessToken(authzDb, {});
    const userB = await seedGrantWithAccessToken(authzDb, {});
    expect(userA.walletAddress.toLowerCase()).not.toBe(
      userB.walletAddress.toLowerCase(),
    );

    fake.payerAccount = "0.0.777";
    fake.payerEvm = userA.walletAddress;
    const mcpA = await connectWithAuth(userA.token);
    const resultA = await call(mcpA, "buy_access", {
      assetId: asset.assetId,
    });
    expect(resultA.isError).toBe(false);
    await mcpA.close();

    fake.payerEvm = userB.walletAddress;
    const mcpB = await connectWithAuth(userB.token);
    const resultB = await call(mcpB, "buy_access", {
      assetId: asset.assetId,
    });
    expect(resultB.isError).toBe(false);
    await mcpB.close();

    const licenseeA = (resultA.body.receipt as { licensee: string }).licensee;
    const licenseeB = (resultB.body.receipt as { licensee: string }).licensee;
    expect(licenseeA.toLowerCase()).toBe(userA.walletAddress.toLowerCase());
    expect(licenseeB.toLowerCase()).toBe(userB.walletAddress.toLowerCase());
    expect(licenseeA.toLowerCase()).not.toBe(licenseeB.toLowerCase());
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

  // Codex review, Phase 7 (the fix, not just the unit test above): a presented-but-invalid
  // token must fail closed even during the MCP_AUTH_REQUIRED=false rollout window - it must
  // NOT be treated the same as no token at all, or a garbage/revoked credential would
  // silently buy the caller legacy unauthenticated access instead of being refused.
  it("refuses buy_access with AUTH_TOKEN_INVALID for a presented-but-invalid token even while MCP_AUTH_REQUIRED=false", async () => {
    await setup({ MCP_AUTH_REQUIRED: "false" });
    const mcp = await connectWithAuth("this-is-not-a-real-token");
    const result = await call(mcp, "buy_access", { assetId: asset.assetId });
    expect(result).toMatchObject({
      isError: true,
      body: { code: "AUTH_TOKEN_INVALID" },
    });
    expect(fake.settleCalls).toBe(0);
    await mcp.close();
  });
});
