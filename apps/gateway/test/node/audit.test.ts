import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  denyOutcome,
  sanitizeAuditSubject,
  writeAudit,
} from "../../src/audit/log";
import * as schema from "../../src/db/schema";
import type { Db } from "../../src/db/types";

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

const SIG = `0x${"ab".repeat(65)}`;

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

describe("audit_log writer (T079, FR-023, R-1a)", () => {
  it("should strip signature keys (authSig / keyGateSig / serverSignature / signatures / signatureHex)", () => {
    expect(
      sanitizeAuditSubject({
        assetId: "0x01",
        authSig: SIG,
        keyGateSig: SIG,
        signatures: [SIG, SIG],
        signatureHex: SIG,
        nested: {
          serverSignature: SIG,
          tokenId: 7n,
          list: [{ sig: SIG, ok: 1 }],
        },
      }),
    ).toEqual({
      assetId: "0x01",
      nested: { tokenId: "7", list: [{ ok: 1 }] },
    });
  });

  it("should strip 65-byte signature values under any key (payload.proof, arrays)", () => {
    expect(
      sanitizeAuditSubject({
        payload: { proof: SIG, receiptHash: `0x${"aa".repeat(32)}` },
        values: [SIG, "keep", 1],
      }),
    ).toEqual({
      payload: { receiptHash: `0x${"aa".repeat(32)}` },
      values: ["keep", 1],
    });
  });

  it("should record an allow entry with the on-chain reference", async () => {
    const id = await writeAudit(db, {
      actor: `0x${"11".repeat(20)}`,
      action: "consume",
      subject: {
        receiptHash: `0x${"aa".repeat(32)}`,
        useIndex: 0,
        authSig: SIG,
        payload: { proof: SIG },
      },
      outcome: "allow",
      onchainRef: `0x${"bb".repeat(32)}`,
    });
    expect(typeof id).toBe("bigint");
    const [row] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.id, id));
    expect(row?.action).toBe("consume");
    expect(row?.outcome).toBe("allow");
    expect(row?.onchainRef).toBe(`0x${"bb".repeat(32)}`);
    expect(row?.subject).toEqual({
      receiptHash: `0x${"aa".repeat(32)}`,
      useIndex: 0,
      payload: {},
    });
    const serialized = JSON.stringify(row, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(serialized).not.toContain("ab".repeat(65));
  });

  it("should record deny entries as deny:<ErrorCode>", async () => {
    const id = await writeAudit(db, {
      action: "deny",
      subject: { assetId: "0x01" },
      outcome: denyOutcome("OWNER_EPOCH_MISMATCH"),
    });
    const [row] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.id, id));
    expect(row?.outcome).toBe("deny:OWNER_EPOCH_MISMATCH");
    expect(row?.actor).toBeNull();
  });
});
