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
 * constraints the gateway's exactly-once guarantees rely on (constitution V).
 */
const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

const H = (byte: string): Hex => `0x${byte.repeat(32)}`;
const W = (byte: string): Hex => `0x${byte.repeat(20)}`;

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
  it("should create all seven gateway tables from data-model.md 2.3", async () => {
    const rows = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name not like '__drizzle%' order by table_name",
    );
    expect(rows.rows.map((r) => r.table_name)).toEqual([
      "audit_log",
      "auth_nonce",
      "mcp_session_binding",
      "payment_binding",
      "receipt_consumption",
      "subgraph_cache",
      "wallet_blinded_shares",
    ]);
  });
});

describe("receipt_consumption", () => {
  it("should reject a second row for the same (receipt_hash, use_index) with a UNIQUE violation", async () => {
    await db.insert(schema.receiptConsumption).values({
      receiptHash: H("a1"),
      useIndex: 0,
      wallet: W("01"),
      status: "locked",
    });
    let caught: unknown;
    try {
      await db.insert(schema.receiptConsumption).values({
        receiptHash: H("a1"),
        useIndex: 0,
        wallet: W("02"),
        status: "locked",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);
    // a different use_index is fine
    await db.insert(schema.receiptConsumption).values({
      receiptHash: H("a1"),
      useIndex: 1,
      wallet: W("01"),
      status: "locked",
    });
  });

  it("should reject a status outside locked/settled/failed", async () => {
    let caught: unknown;
    try {
      await db.insert(schema.receiptConsumption).values({
        receiptHash: H("a2"),
        useIndex: 0,
        wallet: W("01"),
        status: "done" as "locked",
      });
    } catch (error) {
      caught = error;
    }
    expect(pgErrorCode(caught)).toBe(PG_CHECK_VIOLATION);
  });

  it("should round-trip bytea columns as 0x hex and lock rows FOR UPDATE inside a transaction", async () => {
    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.receiptConsumption)
        .where(eq(schema.receiptConsumption.receiptHash, H("a1")))
        .for("update");
      expect(rows.map((r) => r.useIndex).sort()).toEqual([0, 1]);
      expect(rows[0]?.receiptHash).toBe(H("a1"));
      expect(rows[0]?.wallet).toBe(W("01"));
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
    let caught: unknown;
    try {
      await db.insert(schema.paymentBinding).values({
        paymentId: H("b1"),
        purchaseRequestHash: H("b3"), // different payload, same paymentId
        amount: 1n,
      });
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught)).toBe(true);
  });
});

describe("wallet_blinded_shares (R-1a)", () => {
  it("should key rows by (asset_id, wallet, path) and constrain path", async () => {
    await db.insert(schema.walletBlindedShares).values({
      assetId: H("c1"),
      wallet: W("03"),
      path: "owner",
      blindedU: H("c2"),
      accessEpochAtGrant: 2n,
    });
    await db.insert(schema.walletBlindedShares).values({
      assetId: H("c1"),
      wallet: W("03"),
      path: "licensee",
      blindedU: H("c3"),
      receiptHash: H("c4"),
    });
    let dup: unknown;
    try {
      await db.insert(schema.walletBlindedShares).values({
        assetId: H("c1"),
        wallet: W("03"),
        path: "owner",
        blindedU: H("c5"),
      });
    } catch (error) {
      dup = error;
    }
    expect(isUniqueViolation(dup)).toBe(true);
    let badPath: unknown;
    try {
      await db.insert(schema.walletBlindedShares).values({
        assetId: H("c1"),
        wallet: W("04"),
        path: "admin" as "owner",
        blindedU: H("c5"),
      });
    } catch (error) {
      badPath = error;
    }
    expect(pgErrorCode(badPath)).toBe(PG_CHECK_VIOLATION);
  });
});

describe("auth_nonce (FR-024)", () => {
  it("should let a nonce be consumed exactly once via a conditional UPDATE", async () => {
    const nonce = H("d1");
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
  it("should bind a receipt to exactly one MCP session", async () => {
    await db.insert(schema.mcpSessionBinding).values({
      receiptHash: H("e1"),
      mcpSessionId: H("e2"),
    });
    let caught: unknown;
    try {
      await db.insert(schema.mcpSessionBinding).values({
        receiptHash: H("e1"),
        mcpSessionId: H("e3"),
      });
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught)).toBe(true);
  });
});
