import { and, eq, sql } from "drizzle-orm";
import { type Hex, keccak256, stringToHex } from "viem";
import { signClaims, verifyClaims } from "../auth/session";
import { mcpSessionBinding, mcpSessionSpend } from "../db/schema";
import type { Db } from "../db/types";
import type { Env } from "../env";
import { AppError } from "../errors";
import { readReceiptSignerSecret, wipe } from "../keygate/vault";

/**
 * MCP session identity (research.md R-9a). The Streamable HTTP transport runs stateless on
 * Workers, so the gateway mints the `Mcp-Session-Id` itself on `initialize` and the client
 * echoes it (MCP spec). The id is an HMAC-signed, expiring token (same MAC root as the owner
 * session / fallback grant), so a client cannot invent fresh sessions - and with them fresh
 * spend budgets - by skipping `initialize`. A receipt bought in one session can only be
 * decrypted from that session, and the per-session spend cap (R-9) is a ledger row that is
 * reserved atomically BEFORE any signature is requested.
 */
export const MCP_SESSION_HEADER = "mcp-session-id";
const SESSION_TTL_SEC = 24 * 60 * 60;
const MAX_HEADER_LENGTH = 1024;

type SessionClaims = { id: string; expiresAt: number };

function nowSec(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

/** Server-issued session id: HMAC(claims) hex token, 24 h lifetime. */
export async function issueSessionId(env: Env, now: Date): Promise<string> {
  const secret = readReceiptSignerSecret(env);
  try {
    return await signClaims<SessionClaims>(secret, "mcp-session", {
      id: crypto.randomUUID(),
      expiresAt: nowSec(now) + SESSION_TTL_SEC,
    });
  } finally {
    wipe(secret);
  }
}

/** Header value -> the session id it carries, or undefined when absent, forged or expired. */
export async function verifySessionId(
  env: Env,
  value: string | null | undefined,
  now: Date,
): Promise<string | undefined> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_HEADER_LENGTH
  ) {
    return undefined;
  }
  const secret = readReceiptSignerSecret(env);
  try {
    const claims = await verifyClaims<SessionClaims>(
      secret,
      "mcp-session",
      value,
      nowSec(now),
    );
    return claims !== undefined && typeof claims.id === "string"
      ? value
      : undefined;
  } finally {
    wipe(secret);
  }
}

/** Stored as a fixed-length bytea: keccak256 of the session token. */
function sessionKey(sessionId: string): Hex {
  return keccak256(stringToHex(sessionId));
}

export function requireSession(sessionId: string | undefined): string {
  if (sessionId === undefined) {
    throw new AppError(
      "MCP_SESSION_MISMATCH",
      "no valid Mcp-Session-Id: initialize the MCP session first",
    );
  }
  return sessionId;
}

export async function bindReceiptToSession(
  db: Db,
  receiptHash: Hex,
  sessionId: string,
): Promise<void> {
  await db
    .insert(mcpSessionBinding)
    .values({ receiptHash, mcpSessionId: sessionKey(sessionId) })
    .onConflictDoNothing();
}

/** decrypt_content step 0: the receipt must have been bought from THIS session. */
export async function assertReceiptBoundToSession(
  db: Db,
  receiptHash: Hex,
  sessionId: string,
): Promise<void> {
  const [row] = await db
    .select({ mcpSessionId: mcpSessionBinding.mcpSessionId })
    .from(mcpSessionBinding)
    .where(eq(mcpSessionBinding.receiptHash, receiptHash))
    .limit(1);
  if (row === undefined || row.mcpSessionId !== sessionKey(sessionId)) {
    throw new AppError(
      "MCP_SESSION_MISMATCH",
      "receipt was not purchased from this MCP session",
    );
  }
}

/**
 * Spend policy (R-9): atomically adds `amount` to the session ledger unless that would exceed
 * `cap`. One conditional UPDATE, so two concurrent purchases cannot both pass the check.
 */
export async function reserveSpend(
  db: Db,
  sessionId: string,
  amount: bigint,
  cap: bigint,
): Promise<boolean> {
  if (amount < 0n || amount > cap) return false;
  const key = sessionKey(sessionId);
  await db
    .insert(mcpSessionSpend)
    .values({ sessionKey: key, spentTinybar: 0n })
    .onConflictDoNothing();
  const rows = await db
    .update(mcpSessionSpend)
    .set({
      spentTinybar: sql`${mcpSessionSpend.spentTinybar} + ${amount.toString()}::numeric`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mcpSessionSpend.sessionKey, key),
        sql`${mcpSessionSpend.spentTinybar} + ${amount.toString()}::numeric <= ${cap.toString()}::numeric`,
      ),
    )
    .returning({ sessionKey: mcpSessionSpend.sessionKey });
  return rows.length > 0;
}

/** Gives a reservation back - only when no value can have moved (caller decides). */
export async function releaseSpend(
  db: Db,
  sessionId: string,
  amount: bigint,
): Promise<void> {
  await db
    .update(mcpSessionSpend)
    .set({
      spentTinybar: sql`greatest(${mcpSessionSpend.spentTinybar} - ${amount.toString()}::numeric, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(mcpSessionSpend.sessionKey, sessionKey(sessionId)));
}
