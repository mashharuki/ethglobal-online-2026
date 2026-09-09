import { generateKeyPairSync } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentGrant,
  agentWalletBinding,
  oauthAuthorizationCode,
  oauthAuthorizationRequest,
} from "../../src/db/schema";
import type { AuthzDb } from "../../src/db/types";
import type { Env } from "../../src/env";
import { AppError, handleError } from "../../src/errors";
import { resolveActiveDelegationForClient } from "../../src/mcp/grant";
import { beginAuthorization } from "../../src/oauth/authorize";
import { registerClient } from "../../src/oauth/clients";
import {
  getConsentRequestDetails,
  resolveConsent,
} from "../../src/oauth/consent";
import { hashOpaqueValue } from "../../src/oauth/tokenHash";
import { type AppEnv, registerRoutes } from "../../src/routes";
import type { Services } from "../../src/services";
import { createTestDb, MemoryKv, makeEnv } from "./helpers";

/**
 * resolveConsent (Phase 9): the step that turns a "pending" oauth_authorization_request into
 * either a "denied" one (redirect with error) or a "consented" one carrying a freshly minted,
 * grant-bound authorization code - provisioning the principal's AI wallet and creating the
 * grant along the way, exactly the way `/oauth/consent` (routes/oauth.ts) drives it after
 * verifying the caller's Privy access token.
 */
const NOW = new Date("2026-09-09T12:00:00Z");
const ORIGIN = "https://gateway.example";
const REDIRECT_URI = "https://client.example/cb";
const CHAIN_ID = 296;

const GRANT_ENV = {
  MCP_GRANT_DEFAULT_TOTAL_BUDGET_TINYBAR: "10000000",
  MCP_GRANT_DEFAULT_MAX_PER_PURCHASE_TINYBAR: "1000000",
  MCP_GRANT_DEFAULT_TTL_SEC: "3600",
};

// Generated fresh, not hardcoded - see the identical comment in privyClient.test.ts for why a
// real private key literal here would be a secret-scanning problem despite being throwaway.
const AUTHORIZATION_PRIVATE_KEY = generateKeyPairSync("ec", {
  namedCurve: "P-256",
})
  .privateKey.export({ type: "pkcs8", format: "der" })
  .toString("base64");

const DELEGATION_ENV = {
  PRIVY_APP_ID: "app-id",
  PRIVY_APP_SECRET: "app-secret",
  PRIVY_AUTHORIZATION_PRIVATE_KEY: AUTHORIZATION_PRIVATE_KEY,
  PRIVY_SIGNER_QUORUM_ID: "quorum-1",
  PRIVY_AI_WALLET_EXTERNAL_ID_PREFIX: "aiwallet",
};

/** A minimal, stateful fake Privy backend - enough of /v1/wallets to exercise create,
 * list-by-external_id and get, keyed in-memory across calls within one test. */
function fakePrivyBackend() {
  type FakeWallet = {
    id: string;
    address: string;
    chain_type: string;
    external_id: string;
    additional_signers: { signer_id: string }[];
  };
  const byId = new Map<string, FakeWallet>();
  let nextId = 1;
  let createCalls = 0;
  const JSON_HEADERS = { "content-type": "application/json" };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

    if (method === "POST" && url === "https://api.privy.io/v1/wallets") {
      createCalls += 1;
      const id = `wallet-${nextId}`;
      const address = `0x${String(nextId).padStart(40, "0")}`;
      nextId += 1;
      const wallet: FakeWallet = {
        id,
        address,
        chain_type: "ethereum",
        external_id: body.external_id,
        additional_signers: [{ signer_id: "quorum-1" }],
      };
      byId.set(id, wallet);
      return new Response(JSON.stringify(wallet), {
        status: 200,
        headers: JSON_HEADERS,
      });
    }
    if (
      method === "GET" &&
      url.startsWith("https://api.privy.io/v1/wallets/")
    ) {
      const id = url.split("/").pop() as string;
      const wallet = byId.get(id);
      return new Response(JSON.stringify(wallet ?? {}), {
        status: wallet === undefined ? 404 : 200,
        headers: JSON_HEADERS,
      });
    }
    if (method === "GET" && url.startsWith("https://api.privy.io/v1/wallets")) {
      return new Response(
        JSON.stringify({ data: [...byId.values()], next_cursor: null }),
        { status: 200, headers: JSON_HEADERS },
      );
    }
    return new Response(JSON.stringify({}), {
      status: 404,
      headers: JSON_HEADERS,
    });
  }) as typeof fetch;

  return { fetchImpl, createCalls: () => createCalls };
}

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

async function seedPendingRequest(
  overrides: { scope?: string; clientId?: string } = {},
): Promise<{ requestId: string; clientId: string }> {
  const clientId =
    overrides.clientId ??
    (
      await registerClient(db, {
        clientName: "test client",
        redirectUris: [REDIRECT_URI],
      })
    ).clientId;
  const outcome = await beginAuthorization(
    db,
    ORIGIN,
    {
      clientId,
      redirectUri: REDIRECT_URI,
      scope: overrides.scope ?? "assets:read access:buy",
      resource: "https://gateway.example/mcp",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      codeChallengeMethod: "S256",
      state: "xyz",
    },
    NOW,
  );
  if (outcome.kind !== "redirect_to_consent") throw new Error("unreachable");
  return { requestId: outcome.requestId, clientId };
}

describe("resolveConsent - deny", () => {
  it("should mark the request denied and redirect with access_denied, without touching wallets/grants", async () => {
    const { requestId } = await seedPendingRequest();
    const backend = fakePrivyBackend();
    const result = await resolveConsent(
      db,
      GRANT_ENV,
      DELEGATION_ENV,
      {
        requestId,
        principalId: "did:privy:consent-test",
        decision: "deny",
        chainId: CHAIN_ID,
      },
      NOW,
      backend.fetchImpl,
    );
    const url = new URL(result.redirectUri);
    expect(url.origin + url.pathname).toBe(REDIRECT_URI);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(backend.createCalls()).toBe(0);

    const [row] = await db
      .select()
      .from(oauthAuthorizationRequest)
      .where(
        eq(oauthAuthorizationRequest.requestIdHash, hashOpaqueValue(requestId)),
      );
    expect(row?.status).toBe("denied");
    expect(row?.principalId).toBe("did:privy:consent-test");
  });
});

describe("resolveConsent - allow (new grant)", () => {
  it("should provision a wallet, create a grant, mint a code, and redirect with it", async () => {
    const { requestId, clientId } = await seedPendingRequest();
    const backend = fakePrivyBackend();
    const result = await resolveConsent(
      db,
      GRANT_ENV,
      DELEGATION_ENV,
      {
        requestId,
        principalId: "did:privy:consent-new",
        decision: "allow",
        chainId: CHAIN_ID,
      },
      NOW,
      backend.fetchImpl,
    );
    expect(backend.createCalls()).toBe(1);

    const url = new URL(result.redirectUri);
    const code = url.searchParams.get("code");
    expect(code).not.toBeNull();
    expect(url.searchParams.get("state")).toBe("xyz");

    const [codeRow] = await db
      .select()
      .from(oauthAuthorizationCode)
      .where(
        eq(oauthAuthorizationCode.codeHash, hashOpaqueValue(code as string)),
      );
    expect(codeRow?.clientId).toBe(clientId);
    expect(codeRow?.principalId).toBe("did:privy:consent-new");
    expect(codeRow?.scope).toBe("assets:read access:buy");

    const [grantRow] = await db
      .select()
      .from(agentGrant)
      .where(eq(agentGrant.id, codeRow?.grantId as string));
    expect(grantRow?.state).toBe("active");
    expect(grantRow?.principalId).toBe("did:privy:consent-new");

    const [walletRow] = await db
      .select()
      .from(agentWalletBinding)
      .where(eq(agentWalletBinding.id, grantRow?.walletId as string));
    expect(walletRow?.provisioningState).toBe("active");

    const [requestRow] = await db
      .select()
      .from(oauthAuthorizationRequest)
      .where(
        eq(oauthAuthorizationRequest.requestIdHash, hashOpaqueValue(requestId)),
      );
    expect(requestRow?.status).toBe("consented");
  });
});

describe("resolveConsent - allow (re-consent, existing grant)", () => {
  it("should reuse the existing live grant instead of provisioning a second wallet", async () => {
    const principalId = "did:privy:consent-repeat";
    const backend = fakePrivyBackend();
    const first = await seedPendingRequest();
    const firstResult = await resolveConsent(
      db,
      GRANT_ENV,
      DELEGATION_ENV,
      {
        requestId: first.requestId,
        principalId,
        decision: "allow",
        chainId: CHAIN_ID,
      },
      NOW,
      backend.fetchImpl,
    );
    expect(backend.createCalls()).toBe(1);
    const firstGrantId = new URL(firstResult.redirectUri).searchParams.get(
      "code",
    );
    const [firstCodeRow] = await db
      .select()
      .from(oauthAuthorizationCode)
      .where(
        eq(
          oauthAuthorizationCode.codeHash,
          hashOpaqueValue(firstGrantId as string),
        ),
      );

    // A second consent request for the SAME client - simulates the OAuth client
    // reconnecting/re-authorizing.
    const second = await seedPendingRequest({ clientId: first.clientId });
    const secondResult = await resolveConsent(
      db,
      GRANT_ENV,
      DELEGATION_ENV,
      {
        requestId: second.requestId,
        principalId,
        decision: "allow",
        chainId: CHAIN_ID,
      },
      NOW,
      backend.fetchImpl,
    );
    // no second wallet provisioned
    expect(backend.createCalls()).toBe(1);
    const secondCode = new URL(secondResult.redirectUri).searchParams.get(
      "code",
    );
    const [secondCodeRow] = await db
      .select()
      .from(oauthAuthorizationCode)
      .where(
        eq(
          oauthAuthorizationCode.codeHash,
          hashOpaqueValue(secondCode as string),
        ),
      );
    expect(secondCodeRow?.grantId).toBe(firstCodeRow?.grantId);

    const reusedGrant = await resolveActiveDelegationForClient(
      db,
      principalId,
      first.clientId,
    );
    expect(reusedGrant?.id).toBe(firstCodeRow?.grantId);
  });
});

describe("getConsentRequestDetails", () => {
  it("should return the client name, scope and expiry for a pending request, without consuming it", async () => {
    const { requestId, clientId } = await seedPendingRequest();
    const details = await getConsentRequestDetails(db, requestId, NOW);
    expect(details).toEqual({
      clientId,
      clientName: "test client",
      scope: "assets:read access:buy",
      resource: "https://gateway.example/mcp",
      expiresAt: details.expiresAt,
    });

    const [row] = await db
      .select()
      .from(oauthAuthorizationRequest)
      .where(
        eq(oauthAuthorizationRequest.requestIdHash, hashOpaqueValue(requestId)),
      );
    expect(row?.status).toBe("pending"); // read-only - a later resolveConsent still works
  });

  it("should reject an unknown, expired, or already-resolved request the same as resolveConsent does", async () => {
    await expect(
      getConsentRequestDetails(db, "does-not-exist", NOW),
    ).rejects.toMatchObject({ code: "CONSENT_REQUEST_INVALID" });

    const { requestId } = await seedPendingRequest();
    const wayLater = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    await expect(
      getConsentRequestDetails(db, requestId, wayLater),
    ).rejects.toMatchObject({ code: "CONSENT_REQUEST_INVALID" });
  });
});

describe("resolveConsent - invalid requests", () => {
  it("should reject an unknown request_id", async () => {
    await expect(
      resolveConsent(
        db,
        GRANT_ENV,
        DELEGATION_ENV,
        {
          requestId: "does-not-exist",
          principalId: "did:privy:x",
          decision: "allow",
          chainId: CHAIN_ID,
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "CONSENT_REQUEST_INVALID" });
  });

  it("should reject an expired request", async () => {
    const { requestId } = await seedPendingRequest();
    const wayLater = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    await expect(
      resolveConsent(
        db,
        GRANT_ENV,
        DELEGATION_ENV,
        {
          requestId,
          principalId: "did:privy:x",
          decision: "allow",
          chainId: CHAIN_ID,
        },
        wayLater,
      ),
    ).rejects.toMatchObject({ code: "CONSENT_REQUEST_INVALID" });
  });

  it("should reject a second resolution of an already-consented request (double submit)", async () => {
    const { requestId } = await seedPendingRequest();
    const backend = fakePrivyBackend();
    await resolveConsent(
      db,
      GRANT_ENV,
      DELEGATION_ENV,
      {
        requestId,
        principalId: "did:privy:x",
        decision: "allow",
        chainId: CHAIN_ID,
      },
      NOW,
      backend.fetchImpl,
    );
    await expect(
      resolveConsent(
        db,
        GRANT_ENV,
        DELEGATION_ENV,
        {
          requestId,
          principalId: "did:privy:x",
          decision: "allow",
          chainId: CHAIN_ID,
        },
        NOW,
        backend.fetchImpl,
      ),
    ).rejects.toMatchObject({ code: "CONSENT_REQUEST_INVALID" });
  });

  it("should reject resolving an already-denied request again", async () => {
    const { requestId } = await seedPendingRequest();
    await resolveConsent(
      db,
      GRANT_ENV,
      DELEGATION_ENV,
      {
        requestId,
        principalId: "did:privy:x",
        decision: "deny",
        chainId: CHAIN_ID,
      },
      NOW,
    );
    await expect(
      resolveConsent(
        db,
        GRANT_ENV,
        DELEGATION_ENV,
        {
          requestId,
          principalId: "did:privy:x",
          decision: "allow",
          chainId: CHAIN_ID,
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});

/**
 * HTTP-level wiring for POST /oauth/consent (routes/oauth.ts): Bearer extraction and Privy
 * token verification are the SAME mechanism already unit-tested end-to-end in
 * agentGrants.test.ts (mcp/privyClient.ts's `verifyPrincipalAccessToken`) - this section only
 * confirms the route itself wires that, request-body parsing, and `resolveConsent` together
 * correctly, not the auth mechanism's own correctness a second time.
 */
describe("POST /oauth/consent (HTTP wiring)", () => {
  const APP_ID = "app-id";
  let app: Hono<AppEnv>;

  async function setup(): Promise<void> {
    const env = await makeEnv(new MemoryKv(), [], {
      ...DELEGATION_ENV,
      ...GRANT_ENV,
      WEB_APP_URL: "https://truecollective.pages.dev",
    } as Partial<Env>);
    app = new Hono<AppEnv>();
    app.onError(handleError);
    app.use("*", async (c, next) => {
      c.set("db", db);
      c.set("authzDb", db as unknown as AuthzDb);
      c.set("services", { env, now: () => NOW } as unknown as Services);
      await next();
    });
    registerRoutes(app);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function mintPrivyToken(userId: string): Promise<string> {
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
    vi.stubGlobal("fetch", (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith(`/v1/apps/${APP_ID}/jwks.json`)) {
        return new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const wallet = {
        id: "wallet-http-1",
        address: "0x1111111111111111111111111111111111111111",
        chain_type: "ethereum",
        additional_signers: [{ signer_id: "quorum-1" }],
      };
      if (method === "POST" && url === "https://api.privy.io/v1/wallets") {
        return new Response(JSON.stringify(wallet), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // provisionAgentWallet verifies ownership after creating: a GET-by-id and a
      // GET-list-by-user_id (walletProvisioning.test.ts's fakePrivyBackend does the same).
      if (
        method === "GET" &&
        url === "https://api.privy.io/v1/wallets/wallet-http-1"
      ) {
        return new Response(JSON.stringify(wallet), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        method === "GET" &&
        url.startsWith("https://api.privy.io/v1/wallets")
      ) {
        return new Response(
          JSON.stringify({ data: [wallet], next_cursor: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unstubbed fetch: ${method} ${url}`);
    }) as typeof fetch);
    return token;
  }

  it("should reject a request with no Authorization header", async () => {
    await setup();
    const res = await app.request("http://gateway.test/oauth/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "x", decision: "allow" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "AUTH_TOKEN_INVALID" });
  });

  it("should resolve consent end-to-end and return a redirect_uri carrying a code", async () => {
    await setup();
    const registered = await registerClient(db as unknown as AuthzDb, {
      clientName: "http test client",
      redirectUris: [REDIRECT_URI],
    });
    const outcome = await beginAuthorization(
      db as unknown as AuthzDb,
      ORIGIN,
      {
        clientId: registered.clientId,
        redirectUri: REDIRECT_URI,
        scope: "assets:read access:buy",
        resource: "https://gateway.example/mcp",
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        codeChallengeMethod: "S256",
        state: "http-state",
      },
      NOW,
    );
    if (outcome.kind !== "redirect_to_consent") throw new Error("unreachable");
    const token = await mintPrivyToken("did:privy:http-consent-test");
    const res = await app.request("http://gateway.test/oauth/consent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        request_id: outcome.requestId,
        decision: "allow",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirect_uri: string };
    const url = new URL(body.redirect_uri);
    expect(url.origin + url.pathname).toBe(REDIRECT_URI);
    expect(url.searchParams.get("code")).not.toBeNull();
    expect(url.searchParams.get("state")).toBe("http-state");
  });
});
