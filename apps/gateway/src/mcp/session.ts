import { eq } from "drizzle-orm";
import { type Hex, keccak256, stringToHex } from "viem";
import { mcpSessionBinding, paymentBinding } from "../db/schema";
import type { Db } from "../db/types";
import { AppError } from "../errors";

/**
 * MCP session identity (research.md R-9a). The Streamable HTTP transport runs stateless on
 * Workers, so the gateway mints the `Mcp-Session-Id` itself on `initialize` and the client
 * echoes it on every later request (MCP spec). Tools read it from the request headers; a
 * receipt bought in one session can only be decrypted from that session, and the per-session
 * spend cap (R-9) is defined over the same id.
 */
export const MCP_SESSION_HEADER = "mcp-session-id";
const SESSION_ID_RE = /^[A-Za-z0-9._~-]{8,128}$/;

export function newSessionId(): string {
  return crypto.randomUUID();
}

/** Header value -> validated session id, or undefined when absent / malformed. */
export function sessionIdFromHeader(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string" || !SESSION_ID_RE.test(value)) return undefined;
  return value;
}

/** Stored as a fixed-length bytea: keccak256 of the session id. */
function sessionKey(sessionId: string): Hex {
  return keccak256(stringToHex(sessionId));
}

export function requireSession(sessionId: string | undefined): string {
  if (sessionId === undefined) {
    throw new AppError(
      "MCP_SESSION_MISMATCH",
      "no Mcp-Session-Id: initialize the MCP session first",
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

/** tinybar already settled for receipts bought from this session (spend cap input, R-9). */
export async function sessionSpendTinybar(
  db: Db,
  sessionId: string,
): Promise<bigint> {
  const rows = await db
    .select({ amount: paymentBinding.amount })
    .from(mcpSessionBinding)
    .innerJoin(
      paymentBinding,
      eq(paymentBinding.receiptHash, mcpSessionBinding.receiptHash),
    )
    .where(eq(mcpSessionBinding.mcpSessionId, sessionKey(sessionId)));
  return rows.reduce((sum, row) => sum + row.amount, 0n);
}
