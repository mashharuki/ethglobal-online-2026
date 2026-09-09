import type { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthzDb, Db } from "../../src/db/types";
import { handleError } from "../../src/errors";
import { type AppEnv, registerRoutes } from "../../src/routes";
import { createTestDb } from "./helpers";

/**
 * HTTP-level tests for the OAuth discovery + DCR routes (specs/mcp-auth-remediation-plan.md
 * §6). Only the routes actually registered so far (.well-known/*, POST /oauth/register) -
 * /authorize, /token, /revoke land in a follow-up PR with their own tests.
 */
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
