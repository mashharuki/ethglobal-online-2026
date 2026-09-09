import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentGrant,
  agentWalletBinding,
  oauthAuthorizationCode,
} from "../../src/db/schema";
import type { AuthzDb, Db } from "../../src/db/types";
import { handleError } from "../../src/errors";
import { registerClient } from "../../src/oauth/clients";
import {
  generateOpaqueValue,
  hashOpaqueValue,
} from "../../src/oauth/tokenHash";
import { type AppEnv, registerRoutes } from "../../src/routes";
import { createTestDb } from "./helpers";

/**
 * HTTP-level tests for the OAuth routes (specs/mcp-auth-remediation-plan.md §6). Focused on
 * HTTP wiring (status codes, content type, response shape, env-derived redirect target) - the
 * business-logic edge cases are covered directly against oauth/authorize.ts, oauth/token.ts,
 * oauth/revoke.ts in their own test files.
 */
const WEB_APP_URL = "https://truecollective.pages.dev";
const NOW = new Date("2026-09-09T12:00:00Z");
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT_URI = "https://client.example/cb";

let db: Db;
let client: PGlite;
let app: Hono<AppEnv>;

beforeEach(async () => {
  const handle = await createTestDb();
  db = handle.db;
  client = handle.client;
  app = new Hono<AppEnv>();
  app.onError(handleError);
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("authzDb", db as unknown as AuthzDb);
    await next();
  });
  registerRoutes(app);
});

afterEach(async () => {
  await client.close();
});

describe("GET /.well-known/oauth-protected-resource", () => {
  it("should describe /mcp as the protected resource under the request's own origin", async () => {
    const res = await app.request(
      "https://gateway.example/.well-known/oauth-protected-resource",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      resource: "https://gateway.example/mcp",
      authorization_servers: ["https://gateway.example"],
    });
  });
});

describe("GET /.well-known/oauth-authorization-server", () => {
  it("should list every endpoint under the request's own origin", async () => {
    const res = await app.request(
      "https://gateway.example/.well-known/oauth-authorization-server",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token_endpoint: string };
    expect(body.token_endpoint).toBe("https://gateway.example/oauth/token");
  });
});

describe("POST /oauth/register", () => {
  it("should register a client and return 201 with no client_secret in the response", async () => {
    const res = await app.request("https://gateway.example/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Code",
        redirect_uris: ["http://127.0.0.1:51234/callback"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.client_id).toBe("string");
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body).not.toHaveProperty("client_secret");
  });

  it("should answer 400 for a redirect_uri that isn't https: or loopback http:", async () => {
    const res = await app.request("https://gateway.example/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "bad",
        redirect_uris: ["http://attacker.example/cb"],
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("should succeed with a fallback display name when client_name is omitted (RFC 7591 §2: optional)", async () => {
    const res = await app.request("https://gateway.example/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://x.example/cb"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_name: string };
    expect(body.client_name).toBe("Unnamed client");
  });
});

describe("GET /oauth/authorize", () => {
  it("should redirect to WEB_APP_URL/ai-consent with a request_id for a valid request", async () => {
    const registered = await registerClient(db as unknown as AuthzDb, {
      clientName: "x",
      redirectUris: [REDIRECT_URI],
    });
    const url = new URL("https://gateway.example/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", registered.clientId);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", "assets:read");
    url.searchParams.set("resource", "https://gateway.example/mcp");
    url.searchParams.set("code_challenge", CODE_CHALLENGE);
    url.searchParams.set("code_challenge_method", "S256");

    const res = await app.request(
      url.toString(),
      { redirect: "manual" },
      { WEB_APP_URL },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") as string);
    expect(location.origin).toBe(WEB_APP_URL);
    expect(location.pathname).toBe("/ai-consent");
    expect(location.searchParams.get("request_id")).toBeTruthy();
  });

  it("should redirect back to the client's own redirect_uri with an OAuth error for an invalid scope", async () => {
    const registered = await registerClient(db as unknown as AuthzDb, {
      clientName: "x",
      redirectUris: [REDIRECT_URI],
    });
    const url = new URL("https://gateway.example/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", registered.clientId);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", "admin:everything");
    url.searchParams.set("resource", "https://gateway.example/mcp");
    url.searchParams.set("code_challenge", CODE_CHALLENGE);
    url.searchParams.set("code_challenge_method", "S256");

    const res = await app.request(
      url.toString(),
      { redirect: "manual" },
      { WEB_APP_URL },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") as string);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("invalid_scope");
  });

  it("should answer 400 (not redirect) for an unknown client_id", async () => {
    const url = new URL("https://gateway.example/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", crypto.randomUUID());
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", "assets:read");
    url.searchParams.set("resource", "https://gateway.example/mcp");
    url.searchParams.set("code_challenge", CODE_CHALLENGE);
    url.searchParams.set("code_challenge_method", "S256");

    const res = await app.request(url.toString(), {}, { WEB_APP_URL });
    expect(res.status).toBe(400);
  });
});

/** Simulates what the not-yet-built /oauth/consent would have produced. */
async function seedConsentedCode() {
  const principalId = "did:privy:route-test";
  const walletId = crypto.randomUUID();
  await db.insert(agentWalletBinding).values({
    id: walletId,
    principalId,
    purpose: "mcp-agent",
    chainType: "ethereum",
    chainId: 296,
    delegationShape: "additional-signer",
    externalId: `aiwallet-route-test-${walletId}`,
    provisioningKey: `aiwallet:v1:route-test:${walletId}`,
    provisioningState: "active",
    privyWalletId: `privy-${walletId}`,
    address: `0x${"33".repeat(20)}`,
    signerQuorumId: "quorum-1",
    signerState: "attached",
    ownerVerifiedAt: NOW,
  });
  const registered = await registerClient(db as unknown as AuthzDb, {
    clientName: "x",
    redirectUris: [REDIRECT_URI],
  });
  const grantId = crypto.randomUUID();
  await db.insert(agentGrant).values({
    id: grantId,
    principalId,
    walletId,
    clientId: registered.clientId,
    scope: "assets:read access:buy",
    chainId: 296,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    totalBudgetTinybar: 10_000_000n,
    maxPerPurchaseTinybar: 1_000_000n,
  });
  const code = generateOpaqueValue();
  await db.insert(oauthAuthorizationCode).values({
    codeHash: hashOpaqueValue(code),
    requestIdHash: hashOpaqueValue(generateOpaqueValue()),
    clientId: registered.clientId,
    principalId,
    grantId,
    redirectUri: REDIRECT_URI,
    codeChallenge: CODE_CHALLENGE,
    scope: "assets:read access:buy",
    resource: "https://gateway.example/mcp",
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  return { code, clientId: registered.clientId };
}

describe("POST /oauth/token", () => {
  it("should exchange a valid authorization_code for a Bearer token pair (form-urlencoded)", async () => {
    const { code, clientId } = await seedConsentedCode();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: CODE_VERIFIER,
    });
    const res = await app.request("https://gateway.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.token_type).toBe("Bearer");
    expect(typeof json.access_token).toBe("string");
    expect(typeof json.refresh_token).toBe("string");
  });

  it("should answer an OAuth-shaped 400 error for an invalid_grant (unknown code)", async () => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: "does-not-exist",
      redirect_uri: REDIRECT_URI,
      client_id: crypto.randomUUID(),
      code_verifier: CODE_VERIFIER,
    });
    const res = await app.request("https://gateway.example/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.error).toBe("invalid_grant");
    expect(typeof json.error_description).toBe("string");
  });

  it("should refresh via the refresh_token grant (form-urlencoded)", async () => {
    const { code, clientId } = await seedConsentedCode();
    const exchangeRes = await app.request(
      "https://gateway.example/oauth/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: CODE_VERIFIER,
        }).toString(),
      },
    );
    const { refresh_token: refreshToken } = (await exchangeRes.json()) as {
      refresh_token: string;
    };

    const refreshRes = await app.request(
      "https://gateway.example/oauth/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        }).toString(),
      },
    );
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as Record<string, unknown>;
    expect(typeof refreshed.access_token).toBe("string");
    expect(refreshed.refresh_token).not.toBe(refreshToken);
  });
});

describe("POST /oauth/revoke", () => {
  it("should answer 200 for a real token", async () => {
    const { code, clientId } = await seedConsentedCode();
    const exchangeRes = await app.request(
      "https://gateway.example/oauth/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: CODE_VERIFIER,
        }).toString(),
      },
    );
    const { access_token: accessToken } = (await exchangeRes.json()) as {
      access_token: string;
    };
    const res = await app.request("https://gateway.example/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }).toString(),
    });
    expect(res.status).toBe(200);
  });

  it("should still answer 200 for an unknown token (RFC 7009 §2.2 - never leak validity)", async () => {
    const res = await app.request("https://gateway.example/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "unknown-token-value" }).toString(),
    });
    expect(res.status).toBe(200);
  });
});
