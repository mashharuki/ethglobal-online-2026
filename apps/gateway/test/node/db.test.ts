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
    await insert(H("a1"), 1, W("01"));
    await insert(H("a9"), 0, W("01"));
    const rows = await db
      .select()
      .from(schema.receiptConsumption)
      .where(eq(schema.receiptConsumption.useIndex, 0));
    expect(rows.map((r) => r.receiptHash).sort()).toEqual([H("a1"), H("a9")]);
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
