import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { type Address, bytesToHex, type Hex } from "viem";
import { authNonce, type NoncePurpose } from "../db/schema";
import type { Db } from "../db/types";
import { AppError } from "../errors";

/**
 * auth_nonce lifecycle (tasks.md T078, FR-024): 32 random bytes, TTL 120 s, bound to
 * (wallet, purpose, chainId), consumed exactly once by a conditional UPDATE - the database
 * row is the single source of truth, so concurrent replays of one challenge can never both
 * succeed.
 */
export const NONCE_TTL_SEC = 120;
/** How many open challenges per (wallet, purpose) are tried when matching a signature. */
const OPEN_NONCE_SCAN_LIMIT = 10;

export type NonceRow = {
  nonce: Hex;
  wallet: Address;
  purpose: NoncePurpose;
  chainId: number;
  expiresAt: Date;
};

export type IssuedNonce = { nonce: Hex; expiresAt: Date };

export async function issueNonce(
  db: Db,
  input: {
    wallet: Address;
    purpose: NoncePurpose;
    chainId: number;
    now?: Date;
  },
): Promise<IssuedNonce> {
  const now = input.now ?? new Date();
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(now.getTime() + NONCE_TTL_SEC * 1000);
  await db.insert(authNonce).values({
    nonce,
    wallet: input.wallet,
    purpose: input.purpose,
    chainId: input.chainId,
    expiresAt,
  });
  return { nonce, expiresAt };
}

/** Unused, unexpired challenges for a wallet + purpose (newest first). */
export async function listOpenNonces(
  db: Db,
  input: { wallet: Address; purpose: NoncePurpose; now?: Date },
): Promise<NonceRow[]> {
  const now = input.now ?? new Date();
  const rows = await db
    .select()
    .from(authNonce)
    .where(
      and(
        eq(authNonce.wallet, input.wallet),
        eq(authNonce.purpose, input.purpose),
        isNull(authNonce.usedAt),
        gt(authNonce.expiresAt, now),
      ),
    )
    .orderBy(desc(authNonce.expiresAt))
    .limit(OPEN_NONCE_SCAN_LIMIT);
  return rows.map((r) => ({
    nonce: r.nonce,
    wallet: r.wallet as Address,
    purpose: r.purpose,
    chainId: r.chainId,
    expiresAt: r.expiresAt,
  }));
}

/**
 * Marks the nonce used. Exactly one caller wins the conditional UPDATE; everyone else gets
 * NONCE_INVALID_OR_EXPIRED (unknown, expired, already used, or bound to another wallet).
 */
export async function consumeNonce(
  db: Db,
  input: {
    nonce: Hex;
    wallet: Address;
    purpose: NoncePurpose;
    chainId: number;
    now?: Date;
  },
): Promise<NonceRow> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(authNonce)
    .set({ usedAt: now })
    .where(
      and(
        eq(authNonce.nonce, input.nonce),
        eq(authNonce.wallet, input.wallet),
        eq(authNonce.purpose, input.purpose),
        eq(authNonce.chainId, input.chainId),
        isNull(authNonce.usedAt),
        gt(authNonce.expiresAt, now),
      ),
    )
    .returning();
  if (row === undefined) throw new AppError("NONCE_INVALID_OR_EXPIRED");
  return {
    nonce: row.nonce,
    wallet: row.wallet as Address,
    purpose: row.purpose,
    chainId: row.chainId,
    expiresAt: row.expiresAt,
  };
}

export function toUnixSeconds(date: Date): bigint {
  return BigInt(Math.floor(date.getTime() / 1000));
}
