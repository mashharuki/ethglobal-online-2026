import type { PGlite } from "@electric-sql/pglite";
import type { Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  consumeNonce,
  issueNonce,
  listOpenNonces,
  NONCE_TTL_SEC,
} from "../../src/auth/nonce";
import type { Db } from "../../src/db/types";
import { AppError } from "../../src/errors";
import { createTestDb } from "./helpers";

const WALLET: Address = "0x00000000000000000000000000000000000000a1";
const OTHER: Address = "0x00000000000000000000000000000000000000b2";

let db: Db;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
});

afterAll(async () => {
  await client.close();
});

describe("auth_nonce lifecycle (T078, FR-024)", () => {
  it("should issue a 32-byte nonce with a 120 s TTL and list it as open", async () => {
    const now = new Date("2026-09-06T00:00:00Z");
    const issued = await issueNonce(db, {
      wallet: WALLET,
      purpose: "owner-access",
      chainId: 296,
      now,
    });
    expect(issued.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(issued.expiresAt.getTime() - now.getTime()).toBe(
      NONCE_TTL_SEC * 1000,
    );
    const open = await listOpenNonces(db, {
      wallet: WALLET,
      purpose: "owner-access",
      now,
    });
    expect(open.map((r) => r.nonce)).toContain(issued.nonce);
  });

  it("should let exactly one of 20 concurrent consumers win (replay is rejected)", async () => {
    const now = new Date("2026-09-06T00:00:00Z");
    const { nonce } = await issueNonce(db, {
      wallet: WALLET,
      purpose: "owner-access",
      chainId: 296,
      now,
    });
    const attempt = {
      nonce,
      wallet: WALLET,
      purpose: "owner-access" as const,
      chainId: 296,
      now,
    };
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => consumeNonce(db, attempt)),
    );
    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(19);
    for (const loss of losses) {
      expect((loss as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
      expect(((loss as PromiseRejectedResult).reason as AppError).code).toBe(
        "NONCE_INVALID_OR_EXPIRED",
      );
    }
  });

  it("should reject an expired nonce, another wallet, another purpose and another chain", async () => {
    const now = new Date("2026-09-06T00:00:00Z");
    const { nonce } = await issueNonce(db, {
      wallet: WALLET,
      purpose: "keygate-challenge",
      chainId: 296,
      now,
    });
    const base = {
      nonce,
      wallet: WALLET,
      purpose: "keygate-challenge" as const,
      chainId: 296,
    };
    await expect(
      consumeNonce(db, { ...base, wallet: OTHER, now }),
    ).rejects.toMatchObject({ code: "NONCE_INVALID_OR_EXPIRED" });
    await expect(
      consumeNonce(db, { ...base, purpose: "owner-access", now }),
    ).rejects.toMatchObject({ code: "NONCE_INVALID_OR_EXPIRED" });
    await expect(
      consumeNonce(db, { ...base, chainId: 295, now }),
    ).rejects.toMatchObject({ code: "NONCE_INVALID_OR_EXPIRED" });
    await expect(
      consumeNonce(db, {
        ...base,
        now: new Date(now.getTime() + (NONCE_TTL_SEC + 1) * 1000),
      }),
    ).rejects.toMatchObject({ code: "NONCE_INVALID_OR_EXPIRED" });
    // still consumable exactly once within the window by the right party
    const row = await consumeNonce(db, { ...base, now });
    expect(row.nonce).toBe(nonce);
    expect(
      await listOpenNonces(db, {
        wallet: WALLET,
        purpose: "keygate-challenge",
        now,
      }),
    ).toHaveLength(0);
  });
});
