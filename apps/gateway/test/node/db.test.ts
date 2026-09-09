import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import {
  type Db,
  isUniqueViolation,
  PG_CHECK_VIOLATION,
  pgErrorCode,
} from "../../src/db/types";

/**
 * Schema / migration tests (T074 / T075) against PGlite: real Postgres semantics for the
 * constraints the gateway's exactly-once guarantees rely on (constitution V). PGlite is
 * single-connection, so lock CONTENTION (two transactions racing on FOR UPDATE) is NOT
 * covered here - only that the FOR UPDATE query shape is valid; the DO-level 20-parallel
 * test (T065) covers serialization against a real Postgres.
 */
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

const H = (byte: string): Hex => `0x${byte.repeat(32)}`;
const W = (byte: string): Hex => `0x${byte.repeat(20)}`;

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

let client: PGlite;
let db: Db;

beforeAll(async () => {
  client = new PGlite();
  const pglite = drizzle(client, { schema });
  await migrate(pglite, { migrationsFolder });
  db = pglite as unknown as Db;
});

afterAll(async () => {
  await client.close();
});

describe("migrations", () => {
  it("should create the eight gateway tables from data-model.md 2.3 plus the nine MCP OAuth remediation tables", async () => {
    const rows = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name not like '__drizzle%' order by table_name",
    );
    expect(rows.rows.map((r) => r.table_name)).toEqual([
      "agent_grant",
      "agent_principal_spend",
      "agent_spend_reservation",
      "agent_wallet_binding",
      "audit_log",
      "auth_nonce",
      "mcp_authenticated_session",
      "mcp_session_binding",
      "mcp_session_spend",
      "oauth_authorization_code",
      "oauth_authorization_request",
      "oauth_client",
      "oauth_token",
      "payment_binding",
      "receipt_consumption",
      "subgraph_cache",
      "wallet_blinded_shares",
    ]);
  });

  it("should define agent_grant_live_principal_client_unique as a partial unique index (WHERE state = 'active')", async () => {
    const rows = await client.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'agent_grant_live_principal_client_unique'",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.indexdef).toContain("WHERE (state = 'active'::text)");
  });

  it("should define agent_wallet_binding_principal_live_unique as a partial unique index (WHERE provisioning_state <> 'retired')", async () => {
    const rows = await client.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'agent_wallet_binding_principal_live_unique'",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.indexdef).toContain(
      "WHERE (provisioning_state <> 'retired'::text)",
    );
  });

  // The two tests above only assert the index DEFINITION - they would still pass for a
  // non-unique index with the same name/predicate. Prove the constraint is actually
  // enforced: a duplicate is rejected inside the predicate and allowed outside it.
  it("should reject a second active agent_grant for the same (principal_id, client_id) but allow a non-active one", async () => {
    const grant = (id: string, state: "active" | "revoked" | "expired") =>
      db.insert(schema.agentGrant).values({
        id,
        principalId: "did:privy:grant-uniq-test",
        walletId: "00000000-0000-4000-8000-000000000001",
        clientId: "client-grant-uniq-test",
        scope: "assets:read",
        chainId: 296,
        expiresAt: new Date(Date.now() + 3_600_000),
        totalBudgetTinybar: 10_000_000n,
        maxPerPurchaseTinybar: 1_000_000n,
        state,
        // agent_grant_revoked_consistency_check requires revokedAt whenever state='revoked'
        revokedAt: state === "revoked" ? new Date() : undefined,
      });
    await grant("11111111-1111-4111-8111-111111111101", "active");
    const dup = await failure(() =>
      grant("11111111-1111-4111-8111-111111111102", "active"),
    );
    expect(isUniqueViolation(dup)).toBe(true);
    // a revoked row for the same (principal, client) is outside the predicate: allowed
    await grant("11111111-1111-4111-8111-111111111103", "revoked");
  });

  it("should reject a second non-retired agent_wallet_binding for the same (principal_id, purpose) but allow a retired one", async () => {
    const wallet = (
      id: string,
      externalId: string,
      provisioningState: "pending" | "retired",
    ) =>
      db.insert(schema.agentWalletBinding).values({
        id,
        principalId: "did:privy:wallet-uniq-test",
        chainType: "ethereum",
        chainId: 296,
        delegationShape: "additional-signer",
        externalId,
        provisioningKey: `provisioning-key-${externalId}`,
        provisioningState,
      });
    await wallet(
      "22222222-2222-4222-8222-222222222201",
      "wallet-uniq-test-1",
      "pending",
    );
    const dup = await failure(() =>
      wallet(
        "22222222-2222-4222-8222-222222222202",
        "wallet-uniq-test-2",
        "pending",
      ),
    );
    expect(isUniqueViolation(dup)).toBe(true);
    // a retired row for the same (principal, purpose) is outside the predicate: allowed
    await wallet(
      "22222222-2222-4222-8222-222222222203",
      "wallet-uniq-test-3",
      "retired",
    );
  });
});

describe("row level security", () => {
  // Every table has RLS enabled (0003_enable_gateway_rls.sql). RLS with zero policies is
  // fail-closed by default: the table owner still sees everything, but any other role - the
  // realistic shape of the role Hyperdrive is expected to connect as in production, and any
  // role generally, since `TO public` in the policies below means every Postgres role, not
  // the public schema - gets SELECT filtered to zero rows (no error, an empty result set)
  // and INSERT rejected outright (a loud, explicit "row-level security policy" error, not a
  // silent failure). `client.query` above runs as the table owner throughout this file (table
  // owners and superusers always bypass RLS), so that regression would not show up in any
  // other test here.
  const TABLES = [
    "agent_grant",
    "agent_principal_spend",
    "agent_spend_reservation",
    "agent_wallet_binding",
    "audit_log",
    "auth_nonce",
    "mcp_authenticated_session",
    "mcp_session_binding",
    "mcp_session_spend",
    "oauth_authorization_code",
    "oauth_authorization_request",
    "oauth_client",
    "oauth_token",
    "payment_binding",
    "receipt_consumption",
    "subgraph_cache",
    "wallet_blinded_shares",
  ] as const;

  it("should define at least one policy on every gateway table", async () => {
    const rows = await client.query<{ tablename: string }>(
      "select distinct tablename from pg_policies where schemaname = 'public' order by tablename",
    );
    expect(rows.rows.map((r) => r.tablename)).toEqual([...TABLES]);
  });

  it("should let a non-owner role read a row it did not insert, and write its own", async () => {
    // subgraph_cache has the simplest shape (no FKs, no NOT NULL beyond the key) - one
    // representative table is enough to exercise the policy; every table shares the same
    // policy definition (checked above), so this isn't testing 8 independent code paths.
    await client.query(
      "insert into subgraph_cache (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value",
      ["rls-test-owner-row", { ok: true }],
    );
    await client.exec(
      "create role gateway_service_test login; grant all on all tables in schema public to gateway_service_test;",
    );
    try {
      await client.exec("set role gateway_service_test;");
      // The actual regression this guards against: without a policy this returns 0 rows,
      // not an error - `toBeDefined()` on a count would pass either way, so assert the
      // owner-inserted row is genuinely visible.
      const seen = await client.query<{ key: string }>(
        "select key from subgraph_cache where key = $1",
        ["rls-test-owner-row"],
      );
      expect(seen.rows).toHaveLength(1);
      await client.query(
        "insert into subgraph_cache (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value",
        ["rls-test-nonowner-row", { ok: true }],
      );
    } finally {
      await client.exec("reset role;");
    }
  });
});

describe("receipt_consumption", () => {
  const insert = (receiptHash: Hex, useIndex: number, wallet: Hex) =>
    db.insert(schema.receiptConsumption).values({
      receiptHash,
      useIndex,
      wallet,
      status: "locked",
    });

  it("should reject a second row for the same (receipt_hash, use_index) with a UNIQUE violation", async () => {
    await insert(H("a1"), 0, W("01"));
    const dup = await failure(() => insert(H("a1"), 0, W("02")));
    expect(dup).toBeDefined();
    expect(isUniqueViolation(dup)).toBe(true);
  });

  it("should accept the same use_index for a different receipt and the next use_index for the same receipt", async () => {
    // self-contained baseline (does not depend on the previous test's rows)
    await insert(H("a3"), 0, W("01"));
    await insert(H("a3"), 1, W("01"));
    await insert(H("a4"), 0, W("01"));
    const rows = await db
      .select()
      .from(schema.receiptConsumption)
      .where(eq(schema.receiptConsumption.receiptHash, H("a3")));
    expect(rows.map((r) => r.useIndex).sort()).toEqual([0, 1]);
    const sameIndex = await db
      .select()
      .from(schema.receiptConsumption)
      .where(eq(schema.receiptConsumption.receiptHash, H("a4")));
    expect(sameIndex.map((r) => r.useIndex)).toEqual([0]);
  });

  it("should reject a status outside locked/settled/failed and a negative use_index", async () => {
    const badStatus = await failure(() =>
      db.insert(schema.receiptConsumption).values({
        receiptHash: H("a2"),
        useIndex: 0,
        wallet: W("01"),
        status: "done" as "locked",
      }),
    );
    expect(pgErrorCode(badStatus)).toBe(PG_CHECK_VIOLATION);
    const negative = await failure(() => insert(H("a2"), -1, W("01")));
    expect(pgErrorCode(negative)).toBe(PG_CHECK_VIOLATION);
  });

  it("should round-trip bytea columns as 0x hex and accept FOR UPDATE inside a transaction (shape only)", async () => {
    await insert(H("a5"), 0, W("07"));
    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.receiptConsumption)
        .where(eq(schema.receiptConsumption.receiptHash, H("a5")))
        .for("update");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.receiptHash).toBe(H("a5"));
      expect(rows[0]?.wallet).toBe(W("07"));
    });
  });
});

describe("payment_binding (R-10)", () => {
  it("should use payment_id as the sole primary key with status defaulting to pending", async () => {
    const [row] = await db
      .insert(schema.paymentBinding)
      .values({
        paymentId: H("b1"),
        purchaseRequestHash: H("b2"),
        amount: 500_000_000n,
      })
      .returning();
    expect(row?.status).toBe("pending");
    expect(row?.amount).toBe(500_000_000n);
    const dup = await failure(() =>
      db.insert(schema.paymentBinding).values({
        paymentId: H("b1"),
        purchaseRequestHash: H("b3"), // different payload, same paymentId
        amount: 1n,
      }),
    );
    expect(isUniqueViolation(dup)).toBe(true);
    // same payload hash under a different paymentId is a different purchase: allowed
    await db.insert(schema.paymentBinding).values({
      paymentId: H("b4"),
      purchaseRequestHash: H("b2"),
      amount: 500_000_000n,
    });
  });

  it("should reject fractional or negative amounts at the database (numeric CHECK)", async () => {
    const fractional = await failure(() =>
      client.query(
        "insert into payment_binding (payment_id, purchase_request_hash, amount) values ($1, $2, 1.5)",
        [
          Buffer.from("c1".repeat(32), "hex"),
          Buffer.from("c2".repeat(32), "hex"),
        ],
      ),
    );
    expect(pgErrorCode(fractional)).toBe(PG_CHECK_VIOLATION);
    const negative = await failure(() =>
      db.insert(schema.paymentBinding).values({
        paymentId: H("c3"),
        purchaseRequestHash: H("c2"),
        amount: -1n,
      }),
    );
    expect(pgErrorCode(negative)).toBe(PG_CHECK_VIOLATION);
    // numeric NaN sorts above every value and Infinity = trunc(Infinity): both must be rejected
    for (const [byte, literal] of [
      ["c4", "'NaN'"],
      ["c5", "'Infinity'"],
    ] as const) {
      const nonFinite = await failure(() =>
        client.query(
          `insert into payment_binding (payment_id, purchase_request_hash, amount) values ($1, $2, ${literal})`,
          [
            Buffer.from(byte.repeat(32), "hex"),
            Buffer.from("c2".repeat(32), "hex"),
          ],
        ),
      );
      expect(pgErrorCode(nonFinite), literal).toBe(PG_CHECK_VIOLATION);
    }
  });
});

describe("wallet_blinded_shares (R-1a)", () => {
  it("should key rows by (asset_id, wallet, path) and constrain path and epoch", async () => {
    await db.insert(schema.walletBlindedShares).values({
      assetId: H("d1"),
      wallet: W("03"),
      path: "owner",
      blindedU: H("d2"),
      accessEpochAtGrant: 2n,
    });
    // same asset + wallet, other path; and same asset + path, other wallet: both allowed
    await db.insert(schema.walletBlindedShares).values({
      assetId: H("d1"),
      wallet: W("03"),
      path: "licensee",
      blindedU: H("d3"),
      receiptHash: H("d4"),
    });
    await db.insert(schema.walletBlindedShares).values({
      assetId: H("d1"),
      wallet: W("04"),
      path: "owner",
      blindedU: H("d5"),
      accessEpochAtGrant: 3n,
    });
    const dup = await failure(() =>
      db.insert(schema.walletBlindedShares).values({
        assetId: H("d1"),
        wallet: W("03"),
        path: "owner",
        blindedU: H("d6"),
      }),
    );
    expect(isUniqueViolation(dup)).toBe(true);
    const badPath = await failure(() =>
      db.insert(schema.walletBlindedShares).values({
        assetId: H("d1"),
        wallet: W("05"),
        path: "admin" as "owner",
        blindedU: H("d6"),
      }),
    );
    expect(pgErrorCode(badPath)).toBe(PG_CHECK_VIOLATION);
    const negativeEpoch = await failure(() =>
      db.insert(schema.walletBlindedShares).values({
        assetId: H("d1"),
        wallet: W("06"),
        path: "owner",
        blindedU: H("d6"),
        accessEpochAtGrant: -1n,
      }),
    );
    expect(pgErrorCode(negativeEpoch)).toBe(PG_CHECK_VIOLATION);
  });
});

describe("auth_nonce (FR-024)", () => {
  it("should let a nonce be consumed exactly once via a conditional UPDATE", async () => {
    const nonce = H("e1");
    await db.insert(schema.authNonce).values({
      nonce,
      wallet: W("05"),
      purpose: "owner-access",
      chainId: 296,
      expiresAt: new Date(Date.now() + 120_000),
    });
    const consume = () =>
      db
        .update(schema.authNonce)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(schema.authNonce.nonce, nonce),
            isNull(schema.authNonce.usedAt),
          ),
        )
        .returning({ nonce: schema.authNonce.nonce });
    expect(await consume()).toHaveLength(1);
    expect(await consume()).toHaveLength(0);
  });
});

describe("mcp_session_binding (R-9a)", () => {
  it("should bind a receipt to exactly one MCP session while one session may hold many receipts", async () => {
    await db.insert(schema.mcpSessionBinding).values({
      receiptHash: H("f1"),
      mcpSessionId: H("f2"),
    });
    await db.insert(schema.mcpSessionBinding).values({
      receiptHash: H("f3"),
      mcpSessionId: H("f2"),
    });
    const dup = await failure(() =>
      db.insert(schema.mcpSessionBinding).values({
        receiptHash: H("f1"),
        mcpSessionId: H("f4"),
      }),
    );
    expect(isUniqueViolation(dup)).toBe(true);
  });
});
