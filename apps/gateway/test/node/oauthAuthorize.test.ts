import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { oauthAuthorizationRequest } from "../../src/db/schema";
import type { AuthzDb } from "../../src/db/types";
import { AppError } from "../../src/errors";
import { beginAuthorization } from "../../src/oauth/authorize";
import { registerClient } from "../../src/oauth/clients";
import { hashOpaqueValue } from "../../src/oauth/tokenHash";
import { createTestDb } from "./helpers";

const NOW = new Date("2026-09-09T12:00:00Z");
const ORIGIN = "https://gateway.example";

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

async function seedClient(redirectUris: string[]) {
  return registerClient(db, { clientName: "test client", redirectUris });
}

const VALID_INPUT_BASE = {
  scope: "assets:read access:buy",
  resource: "https://gateway.example/mcp",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  codeChallengeMethod: "S256",
  state: "xyz",
};

describe("beginAuthorization", () => {
  it("should create a pending authorization request and return its id for a valid request", async () => {
    const registered = await seedClient(["https://client.example/cb"]);
    const outcome = await beginAuthorization(
      db,
      ORIGIN,
      {
        ...VALID_INPUT_BASE,
        clientId: registered.clientId,
        redirectUri: "https://client.example/cb",
      },
      NOW,
    );
    expect(outcome.kind).toBe("redirect_to_consent");
    if (outcome.kind !== "redirect_to_consent") throw new Error("unreachable");

    const [row] = await db
      .select()
      .from(oauthAuthorizationRequest)
      .where(
        eq(
          oauthAuthorizationRequest.requestIdHash,
          hashOpaqueValue(outcome.requestId),
        ),
      );
    expect(row?.clientId).toBe(registered.clientId);
    expect(row?.status).toBe("pending");
    expect(row?.scope).toBe(VALID_INPUT_BASE.scope);
    expect(row?.state).toBe("xyz");
  });

  it("should throw AppError directly (not redirect) for an unknown client_id", async () => {
    await expect(
      beginAuthorization(
        db,
        ORIGIN,
        {
          ...VALID_INPUT_BASE,
          clientId: crypto.randomUUID(),
          redirectUri: "https://client.example/cb",
        },
        NOW,
      ),
    ).rejects.toThrow(AppError);
  });

  it("should throw AppError directly (not redirect) for an unregistered redirect_uri", async () => {
    const registered = await seedClient(["https://client.example/cb"]);
    await expect(
      beginAuthorization(
        db,
        ORIGIN,
        {
          ...VALID_INPUT_BASE,
          clientId: registered.clientId,
          redirectUri: "https://attacker.example/cb",
        },
        NOW,
      ),
    ).rejects.toThrow(AppError);
  });

  it("should redirect_with_error (not throw) for an unsupported code_challenge_method", async () => {
    const registered = await seedClient(["https://client.example/cb"]);
    const outcome = await beginAuthorization(
      db,
      ORIGIN,
      {
        ...VALID_INPUT_BASE,
        clientId: registered.clientId,
        redirectUri: "https://client.example/cb",
        codeChallengeMethod: "plain",
      },
      NOW,
    );
    expect(outcome.kind).toBe("redirect_with_error");
    if (outcome.kind !== "redirect_with_error") throw new Error("unreachable");
    expect(outcome.redirectUri).toBe("https://client.example/cb");
    expect(outcome.error).toBe("invalid_request");
    expect(outcome.state).toBe("xyz");
  });

  it("should redirect_with_error for a scope outside SCOPES_SUPPORTED", async () => {
    const registered = await seedClient(["https://client.example/cb"]);
    const outcome = await beginAuthorization(
      db,
      ORIGIN,
      {
        ...VALID_INPUT_BASE,
        clientId: registered.clientId,
        redirectUri: "https://client.example/cb",
        scope: "admin:everything",
      },
      NOW,
    );
    expect(outcome.kind).toBe("redirect_with_error");
    if (outcome.kind !== "redirect_with_error") throw new Error("unreachable");
    expect(outcome.error).toBe("invalid_scope");
  });

  it("should redirect_with_error for an empty scope", async () => {
    const registered = await seedClient(["https://client.example/cb"]);
    const outcome = await beginAuthorization(
      db,
      ORIGIN,
      {
        ...VALID_INPUT_BASE,
        clientId: registered.clientId,
        redirectUri: "https://client.example/cb",
        scope: "",
      },
      NOW,
    );
    expect(outcome.kind).toBe("redirect_with_error");
  });

  it("should redirect_with_error for a resource that doesn't match this server's own /mcp", async () => {
    const registered = await seedClient(["https://client.example/cb"]);
    const outcome = await beginAuthorization(
      db,
      ORIGIN,
      {
        ...VALID_INPUT_BASE,
        clientId: registered.clientId,
        redirectUri: "https://client.example/cb",
        resource: "https://someone-elses-server.example/mcp",
      },
      NOW,
    );
    expect(outcome.kind).toBe("redirect_with_error");
    if (outcome.kind !== "redirect_with_error") throw new Error("unreachable");
    expect(outcome.error).toBe("invalid_target");
  });

  it("should redirect_with_error for an empty code_challenge", async () => {
    const registered = await seedClient(["https://client.example/cb"]);
    const outcome = await beginAuthorization(
      db,
      ORIGIN,
      {
        ...VALID_INPUT_BASE,
        clientId: registered.clientId,
        redirectUri: "https://client.example/cb",
        codeChallenge: "",
      },
      NOW,
    );
    expect(outcome.kind).toBe("redirect_with_error");
  });

  it("should carry state=null through cleanly when the client didn't send one", async () => {
    const registered = await seedClient(["https://client.example/cb"]);
    const outcome = await beginAuthorization(
      db,
      ORIGIN,
      {
        ...VALID_INPUT_BASE,
        clientId: registered.clientId,
        redirectUri: "https://client.example/cb",
        codeChallengeMethod: "plain", // force an error path
        state: null,
      },
      NOW,
    );
    expect(outcome.kind).toBe("redirect_with_error");
    if (outcome.kind !== "redirect_with_error") throw new Error("unreachable");
    expect(outcome.state).toBeNull();
  });
});
