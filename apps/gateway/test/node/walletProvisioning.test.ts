import { generateKeyPairSync } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { keccak256, stringToHex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentWalletBinding } from "../../src/db/schema";
import type { AuthzDb } from "../../src/db/types";
import { McpToolError } from "../../src/mcp/toolError";
import { provisionAgentWallet } from "../../src/mcp/walletProvisioning";
import { createTestDb } from "./helpers";

/**
 * Integration test against a real PGlite Postgres + a stateful fake Privy backend (stubbed
 * at the HTTP boundary, not by mocking walletProvisioning.ts or privyClient.ts). This is the
 * level that would have caught a real bug found while writing this module: an `&&` used
 * where `and()` was needed in the activation CAS's WHERE clause silently dropped the row-id
 * condition, so the update could in principle match a stale pending row for a DIFFERENT
 * principal. `shouldProvisionIndependentWalletsForDifferentPrincipals` below exercises
 * exactly that shape.
 */
// Generated fresh, not hardcoded - see the identical comment in privyClient.test.ts for why
// a real private key literal here would be a secret-scanning problem despite being throwaway.
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

/** A minimal, stateful fake Privy backend: enough of /v1/wallets to exercise create,
 * list-by-external_id, get, and update, keyed in-memory across calls within one test. */
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

  function seedWallet(externalId: string): FakeWallet {
    const id = `wallet-${nextId}`;
    // a real 20-byte hex address, distinct per seeded wallet - padStart on the id string
    // itself would embed non-hex characters ("wallet-1" -> "...wallet-1"), so pad the
    // numeric suffix instead.
    const address = `0x${String(nextId).padStart(40, "0")}`;
    nextId += 1;
    const wallet: FakeWallet = {
      id,
      address,
      chain_type: "ethereum",
      external_id: externalId,
      additional_signers: [{ signer_id: "quorum-1" }],
    };
    byId.set(id, wallet);
    return wallet;
  }

  const JSON_HEADERS = { "content-type": "application/json" };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

    if (method === "POST" && url === "https://api.privy.io/v1/wallets") {
      createCalls += 1;
      const wallet = seedWallet(body.external_id);
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

  return { fetchImpl, createCalls: () => createCalls, seedWallet };
}

// createTestDb() returns plain Db - provisionAgentWallet requires AuthzDb, so this test's
// single `db` variable is cast once here rather than at every call site.
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

describe("provisionAgentWallet", () => {
  it("should provision a new wallet, reaching the active state with the gateway's signer attached", async () => {
    const backend = fakePrivyBackend();
    const result = await provisionAgentWallet(
      db,
      DELEGATION_ENV,
      { principalId: "did:privy:alice", chainId: 296 },
      backend.fetchImpl,
    );
    expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.signerQuorumId).toBe("quorum-1");
    expect(backend.createCalls()).toBe(1);

    const [row] = await db
      .select()
      .from(agentWalletBinding)
      .where(eq(agentWalletBinding.id, result.id));
    expect(row?.provisioningState).toBe("active");
    expect(row?.signerState).toBe("attached");
    expect(row?.ownerVerifiedAt).not.toBeNull();
  });

  it("should be idempotent: a second call for the same principal returns the same wallet without a second Privy create", async () => {
    const backend = fakePrivyBackend();
    const first = await provisionAgentWallet(
      db,
      DELEGATION_ENV,
      { principalId: "did:privy:bob", chainId: 296 },
      backend.fetchImpl,
    );
    const second = await provisionAgentWallet(
      db,
      DELEGATION_ENV,
      { principalId: "did:privy:bob", chainId: 296 },
      backend.fetchImpl,
    );
    expect(second).toEqual(first);
    expect(backend.createCalls()).toBe(1);
  });

  it("should provision independent wallets for different principals without cross-contamination", async () => {
    // Regression test for the &&-vs-and() bug found while writing walletProvisioning.ts: an
    // activation UPDATE whose WHERE clause silently dropped the row-id condition would let
    // one principal's activation touch another principal's still-pending row. Provisioning
    // two different principals and asserting each ends up with its OWN distinct wallet (and
    // that exactly two rows are active, each pointing at the right wallet) exercises this.
    const backend = fakePrivyBackend();

    const alice = await provisionAgentWallet(
      db,
      DELEGATION_ENV,
      { principalId: "did:privy:alice2", chainId: 296 },
      backend.fetchImpl,
    );
    const carol = await provisionAgentWallet(
      db,
      DELEGATION_ENV,
      { principalId: "did:privy:carol", chainId: 296 },
      backend.fetchImpl,
    );

    expect(alice.privyWalletId).not.toBe(carol.privyWalletId);
    expect(alice.address).not.toBe(carol.address);

    const rows = await db
      .select()
      .from(agentWalletBinding)
      .where(eq(agentWalletBinding.provisioningState, "active"));
    expect(rows).toHaveLength(2);
    const alicesRow = rows.find((r) => r.principalId === "did:privy:alice2");
    const carolsRow = rows.find((r) => r.principalId === "did:privy:carol");
    expect(alicesRow?.privyWalletId).toBe(alice.privyWalletId);
    expect(carolsRow?.privyWalletId).toBe(carol.privyWalletId);
  });

  it("should resume a crashed-and-restarted provisioning attempt by adopting the already-created Privy wallet, not creating a second one", async () => {
    const backend = fakePrivyBackend();
    const principalId = "did:privy:dave";
    // Derive the exact external_id this principal's first (walletEpoch=0) attempt would use,
    // matching walletProvisioning.ts's own externalIdFor/provisioningKeyFor derivation, and
    // pre-seed both a Privy wallet under it AND a "pending" DB row - simulating a crash that
    // happened after the Privy create succeeded but before the row was marked active.
    const externalId = `aiwallet-${keccak256(stringToHex(principalId)).slice(2, 18)}-0`;
    const preSeeded = backend.seedWallet(externalId);
    await db.insert(agentWalletBinding).values({
      id: crypto.randomUUID(),
      principalId,
      purpose: "mcp-agent",
      chainType: "ethereum",
      chainId: 296,
      delegationShape: "additional-signer",
      externalId,
      provisioningKey: `aiwallet:v1:${principalId}:0`,
      provisioningState: "pending",
    });

    const result = await provisionAgentWallet(
      db,
      DELEGATION_ENV,
      { principalId, chainId: 296 },
      backend.fetchImpl,
    );

    expect(backend.createCalls()).toBe(0); // adopted the pre-seeded wallet, never created
    expect(result.privyWalletId).toBe(preSeeded.id);
    expect(result.address.toLowerCase()).toBe(preSeeded.address.toLowerCase());
  });

  it("should resume using the claim row's OWN persisted externalId/provisioningKey, not values recomputed under a since-changed external-id prefix", async () => {
    // Regression test (Codex review, Phase 3b+4): a resume that recomputes externalId from
    // the CURRENT env instead of reading row.externalId would search Privy under the wrong
    // key if PRIVY_AI_WALLET_EXTERNAL_ID_PREFIX changed between the crash and this resume,
    // fail to find the wallet actually created before the crash, and create a duplicate.
    const backend = fakePrivyBackend();
    const principalId = "did:privy:frank";
    const originalExternalId = `original-prefix-${keccak256(stringToHex(principalId)).slice(2, 18)}-0`;
    const preSeeded = backend.seedWallet(originalExternalId);
    await db.insert(agentWalletBinding).values({
      id: crypto.randomUUID(),
      principalId,
      purpose: "mcp-agent",
      chainType: "ethereum",
      chainId: 296,
      delegationShape: "additional-signer",
      externalId: originalExternalId,
      provisioningKey: `original-prefix:v1:${principalId}:0`,
      provisioningState: "pending",
    });

    const result = await provisionAgentWallet(
      db,
      { ...DELEGATION_ENV, PRIVY_AI_WALLET_EXTERNAL_ID_PREFIX: "new-prefix" },
      { principalId, chainId: 296 },
      backend.fetchImpl,
    );

    expect(backend.createCalls()).toBe(0); // adopted the pre-seeded wallet, never duplicated
    expect(result.privyWalletId).toBe(preSeeded.id);
  });

  it("should fail closed with AGENT_WALLET_UNAVAILABLE when the row is already in a failed state", async () => {
    const backend = fakePrivyBackend();
    await db.insert(agentWalletBinding).values({
      id: crypto.randomUUID(),
      principalId: "did:privy:erin",
      purpose: "mcp-agent",
      chainType: "ethereum",
      chainId: 296,
      delegationShape: "additional-signer",
      externalId: "aiwallet-erin-0",
      provisioningKey: "aiwallet:v1:did:privy:erin:0",
      provisioningState: "failed",
      lastErrorCode: "SOME_PRIOR_FAILURE",
    });
    await expect(
      provisionAgentWallet(
        db,
        DELEGATION_ENV,
        { principalId: "did:privy:erin", chainId: 296 },
        backend.fetchImpl,
      ),
    ).rejects.toThrow(McpToolError);
    expect(backend.createCalls()).toBe(0);
  });
});
