import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthzDb } from "../../src/db/types";
import { AppError } from "../../src/errors";
import {
  assertClientUsable,
  registerClient,
  resolveClient,
} from "../../src/oauth/clients";
import { createTestDb } from "./helpers";

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

describe("registerClient", () => {
  it('should register a public ("none"-auth) client with a fresh client_id', async () => {
    const registered = await registerClient(db, {
      clientName: "Claude Code",
      redirectUris: ["http://127.0.0.1:51234/callback"],
    });
    expect(registered.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(registered.tokenEndpointAuthMethod).toBe("none");
    expect(registered.source).toBe("dcr");
    expect(registered.redirectUris).toEqual([
      "http://127.0.0.1:51234/callback",
    ]);
  });

  it("should reject an empty client_name", async () => {
    await expect(
      registerClient(db, {
        clientName: "",
        redirectUris: ["https://client.example/cb"],
      }),
    ).rejects.toThrow(AppError);
  });

  it("should reject zero redirect_uris", async () => {
    await expect(
      registerClient(db, { clientName: "x", redirectUris: [] }),
    ).rejects.toThrow(AppError);
  });

  it("should reject a redirect_uri that isn't https: or loopback http:", async () => {
    await expect(
      registerClient(db, {
        clientName: "x",
        redirectUris: ["http://attacker.example/cb"],
      }),
    ).rejects.toThrow(AppError);
  });

  it("should register independent clients with distinct ids for repeated calls", async () => {
    const a = await registerClient(db, {
      clientName: "a",
      redirectUris: ["https://a.example/cb"],
    });
    const b = await registerClient(db, {
      clientName: "b",
      redirectUris: ["https://b.example/cb"],
    });
    expect(a.clientId).not.toBe(b.clientId);
  });
});

describe("resolveClient / assertClientUsable", () => {
  it("should resolve a registered client by id", async () => {
    const registered = await registerClient(db, {
      clientName: "x",
      redirectUris: ["https://x.example/cb"],
    });
    const resolved = await resolveClient(db, registered.clientId);
    expect(resolved?.clientId).toBe(registered.clientId);
  });

  it("should return undefined for an unknown client id", async () => {
    expect(await resolveClient(db, crypto.randomUUID())).toBeUndefined();
  });

  it("should throw AppError for an unknown client id", async () => {
    await expect(assertClientUsable(db, crypto.randomUUID())).rejects.toThrow(
      AppError,
    );
  });
});
