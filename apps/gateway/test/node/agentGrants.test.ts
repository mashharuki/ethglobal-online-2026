import { generateKeyPairSync } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentGrant, agentWalletBinding, oauthToken } from "../../src/db/schema";
import type { AuthzDb, Db } from "../../src/db/types";
import type { Env } from "../../src/env";
import { handleError } from "../../src/errors";
import { hashOpaqueValue } from "../../src/oauth/tokenHash";
import { type AppEnv, registerRoutes } from "../../src/routes";
import type { Services } from "../../src/services";
import { buildServices, createFake, type Fake, NOW } from "./fakeServices";
import { buildAsset, createTestDb, makeEnv, MemoryKv } from "./helpers";

/**
 * Agent delegation admin routes (Phase 8): the route-level wiring (auth extraction ->
 * ownership check -> DB revoke -> best-effort signer detach -> audit). The security-critical
 * pieces underneath are already unit-tested directly: JWT verification cryptography
 * (privyClient.test.ts's `verifyPrincipalAccessToken` suite, via the SDK's own
 * `jwtVerificationKey` static-key option) and the shared-wallet revoke-count gate
 * (grant.test.ts's `countActiveDelegationsForWallet` suite). Here, the Privy access token IS
 * a real signed JWT verified through the real `jose`/`@privy-io/node` code path - only the
 * network boundary (JWKS fetch, wallet PATCH) is stubbed, via a GLOBAL fetch stub (Codex
 * review note carried over from privyClient.ts: `createRemoteJWKSet` never receives a
 * per-client `fetch` override, so this is the only seam available for a route that doesn't
 * expose one itself, matching how PrivyAPI's own HTTP client resolves `options.fetch ??
 * Shims.getDefaultFetch()`).
 */
const APP_ID = "app-id";
// Generated fresh, not hardcoded - see the identical comment in privyClient.test.ts for why a
// real private key literal here would be a secret-scanning problem despite being throwaway.
const AUTHORIZATION_PRIVATE_KEY = generateKeyPairSync("ec", {
  namedCurve: "P-256",
})
  .privateKey.export({ type: "pkcs8", format: "der" })
  .toString("base64");

let db: Db;
let authzDb: AuthzDb;
let client: PGlite;
let env: Env;
let fake: Fake;
let services: Services;
let app: Hono<AppEnv>;

async function setup(envOverrides: Partial<Env> = {}): Promise<void> {
  const handle = await createTestDb();
  db = handle.db;
  authzDb = handle.db as unknown as AuthzDb;
  client = handle.client;
  const asset = buildAsset("c3");
  env = await makeEnv(new MemoryKv(), [asset], {
    PRIVY_APP_ID: APP_ID,
    PRIVY_APP_SECRET: "app-secret",
    PRIVY_AUTHORIZATION_PRIVATE_KEY: AUTHORIZATION_PRIVATE_KEY,
    PRIVY_SIGNER_QUORUM_ID: "quorum-1",
    PRIVY_AI_WALLET_EXTERNAL_ID_PREFIX: "aiwallet",
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

let nextWalletAddressSeed = 1;

async function seedGrant(
  principalId: string,
  overrides: { walletId?: string; clientId?: string } = {},
): Promise<{ grantId: string; walletId: string }> {
  const walletId =
    overrides.walletId ??
    (await (async () => {
      const id = crypto.randomUUID();
      const addressSeed = nextWalletAddressSeed++;
      await authzDb.insert(agentWalletBinding).values({
        id,
        principalId,
        purpose: "mcp-agent",
        chainType: "ethereum",
        chainId: 296,
        delegationShape: "additional-signer",
        externalId: `aiwallet-agentgrants-test-${id}`,
        provisioningKey: `aiwallet:v1:agentgrants-test:${id}`,
        provisioningState: "active",
        privyWalletId: `privy-${id}`,
        address: `0x${String(addressSeed).padStart(40, "0")}`,
        signerQuorumId: "quorum-1",
        signerState: "attached",
        ownerVerifiedAt: NOW,
      });
      return id;
    })());
  const grantId = crypto.randomUUID();
  const clientId = overrides.clientId ?? `client-${crypto.randomUUID()}`;
  await authzDb.insert(agentGrant).values({
    id: grantId,
    principalId,
    walletId,
    clientId,
    scope: "assets:read access:buy",
    chainId: 296,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    totalBudgetTinybar: 10_000_000n,
    maxPerPurchaseTinybar: 1_000_000n,
  });
  // an oauth_token bound to this grant - revoking the grant must revoke this too.
  await authzDb.insert(oauthToken).values({
    tokenHash: hashOpaqueValue(`token-for-${grantId}`),
    kind: "access",
    grantId,
    clientId,
    principalId,
    scope: "assets:read access:buy",
    resource: "https://gateway.example/mcp",
    expiresAt: new Date(NOW.getTime() + 3_600_000),
  });
  return { grantId, walletId };
}

/** Signs a real Privy-shaped access token and stubs global fetch to serve its JWKS (for
 * verifyPrincipalAccessToken) and a canned wallet PATCH response (for detachDelegatedSigner) -
 * both go through the SDK's default (unset) `fetch`, which resolves to the global one. */
async function mintPrivyTokenAndStubFetch(
  userId: string,
  options: { walletPatchStatus?: number } = {},
): Promise<string> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const kid = "test-key-1";
  const jwks = { keys: [{ ...jwk, kid, alg: "ES256", use: "sig" }] };
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ sid: "session-1" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid })
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
  // sanity: exercise the exported SPKI path too isn't needed here (route uses live JWKS).
  await exportSPKI(publicKey);
  vi.stubGlobal(
    "fetch",
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith(`/v1/apps/${APP_ID}/jwks.json`)) {
        return new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "PATCH" && url.includes("/v1/wallets/")) {
        return new Response(
          JSON.stringify({
            id: "wallet-x",
            address: "0x1111111111111111111111111111111111111111",
            chain_type: "ethereum",
            additional_signers: [],
          }),
          {
            status: options.walletPatchStatus ?? 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`unstubbed fetch: ${method} ${url}`);
    }) as typeof fetch,
  );
  return token;
}

async function call(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(`http://gateway.test${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.body,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /agent/grants", () => {
  it("should reject a request with no Authorization header", async () => {
    await setup();
    const result = await call("/agent/grants");
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: "AUTH_TOKEN_INVALID" });
  });

  it("should reject a garbage Bearer token", async () => {
    await setup();
    const result = await call("/agent/grants", {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: "AUTH_TOKEN_INVALID" });
  });

  it("should list only the caller's own active grants", async () => {
    await setup();
    const { grantId } = await seedGrant("did:privy:list-me");
    await seedGrant("did:privy:someone-else");
    const token = await mintPrivyTokenAndStubFetch("did:privy:list-me");
    const result = await call("/agent/grants", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(result.status).toBe(200);
    const grants = result.body.grants as Array<{ id: string }>;
    expect(grants.map((g) => g.id)).toEqual([grantId]);
  });
});

describe("POST /agent/grants/:grantId/revoke", () => {
  it("should reject a revoke request with no Authorization header", async () => {
    await setup();
    const { grantId } = await seedGrant("did:privy:owner-a");
    const result = await call(`/agent/grants/${grantId}/revoke`, {
      method: "POST",
    });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: "AUTH_TOKEN_INVALID" });
  });

  it("should refuse to revoke a grant belonging to a different principal (404, not 403 - never confirms existence)", async () => {
    await setup();
    const { grantId } = await seedGrant("did:privy:owner-a");
    const token = await mintPrivyTokenAndStubFetch("did:privy:owner-b");
    const result = await call(`/agent/grants/${grantId}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ code: "DELEGATION_NOT_FOUND" });
    const [grantRow] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, grantId));
    expect(grantRow?.state).toBe("active"); // untouched
  });

  it("should answer identically (404) for a grantId that does not exist at all", async () => {
    await setup();
    const token = await mintPrivyTokenAndStubFetch("did:privy:owner-b");
    const result = await call(`/agent/grants/${crypto.randomUUID()}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ code: "DELEGATION_NOT_FOUND" });
  });

  it("should revoke the grant and its oauth tokens, and detach the signer when no sibling grant shares the wallet", async () => {
    await setup();
    const { grantId, walletId } = await seedGrant("did:privy:solo-wallet");
    const token = await mintPrivyTokenAndStubFetch("did:privy:solo-wallet");
    const result = await call(`/agent/grants/${grantId}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      grantId,
      revoked: true,
      signerDetached: true,
    });
    const [grantRow] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, grantId));
    expect(grantRow?.state).toBe("revoked");
    const [tokenRow] = await db
      .select()
      .from(oauthToken)
      .where(eq(oauthToken.grantId, grantId));
    expect(tokenRow?.revokedAt).not.toBeNull();
    void walletId;
  });

  it("should NOT detach the signer when a sibling grant still shares the same wallet", async () => {
    await setup();
    const { grantId, walletId } = await seedGrant("did:privy:shared-wallet");
    await seedGrant("did:privy:shared-wallet", { walletId });
    const token = await mintPrivyTokenAndStubFetch("did:privy:shared-wallet");
    const result = await call(`/agent/grants/${grantId}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ grantId, revoked: true });
    expect(result.body.signerDetached).toBeUndefined();
  });

  it("should report signerDetached: false (not throw) when the Privy PATCH fails", async () => {
    await setup();
    const { grantId } = await seedGrant("did:privy:patch-fails");
    const token = await mintPrivyTokenAndStubFetch("did:privy:patch-fails", {
      walletPatchStatus: 500,
    });
    const result = await call(`/agent/grants/${grantId}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      grantId,
      revoked: true,
      signerDetached: false,
    });
    const [grantRow] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, grantId));
    // the DB revoke is authoritative regardless of the Privy-side failure
    expect(grantRow?.state).toBe("revoked");
  });
});

describe("POST /agent/grants/revoke-all", () => {
  it("should revoke every active grant for the principal (sharing its one live wallet) and detach that wallet's signer", async () => {
    await setup();
    // agent_wallet_binding_principal_live_unique means a principal has exactly one LIVE
    // wallet at a time - every grant it creates for different OAuth clients shares it.
    const a = await seedGrant("did:privy:revoke-all-test");
    const b = await seedGrant("did:privy:revoke-all-test", {
      walletId: a.walletId,
    });
    await seedGrant("did:privy:untouched-principal");
    const token = await mintPrivyTokenAndStubFetch("did:privy:revoke-all-test");
    const result = await call("/agent/grants/revoke-all", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(result.status).toBe(200);
    const revokedGrantIds = result.body.revokedGrantIds as string[];
    expect(revokedGrantIds.sort()).toEqual([a.grantId, b.grantId].sort());
    const signerResults = result.body.signerResults as Record<
      string,
      boolean
    >;
    expect(Object.keys(signerResults)).toEqual([a.walletId]);
    expect(signerResults[a.walletId]).toBe(true);

    for (const grantId of [a.grantId, b.grantId]) {
      const [row] = await db
        .select()
        .from(agentGrant)
        .where(eq(agentGrant.id, grantId));
      expect(row?.state).toBe("revoked");
    }
    const [untouchedRow] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.principalId, "did:privy:untouched-principal"));
    expect(untouchedRow?.state).toBe("active");
  });

  it("should return empty results for a principal with no active grants", async () => {
    await setup();
    const token = await mintPrivyTokenAndStubFetch("did:privy:no-grants-at-all");
    const result = await call("/agent/grants/revoke-all", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ revokedGrantIds: [], signerResults: {} });
  });
});
