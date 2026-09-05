import type { ErrorCode } from "@truenft/shared";
import type { Hex } from "viem";
import { type AuditAction, auditLog } from "../db/schema";
import type { Db } from "../db/types";

/**
 * audit_log writer (tasks.md T079, FR-023). Every allow / deny decision on a key operation
 * is recorded with the on-chain reference when one exists. Signature values are never
 * stored (R-1a): any subject key that looks like a signature is dropped before insert.
 */
export type AuditOutcome = "allow" | `deny:${ErrorCode}`;

export type AuditEntry = {
  actor?: Hex;
  action: AuditAction;
  subject: Record<string, unknown>;
  outcome: AuditOutcome;
  onchainRef?: Hex;
};

export function denyOutcome(code: ErrorCode): AuditOutcome {
  return `deny:${code}`;
}

const SIGNATURE_KEY_RE = /(sig|signature)$/i;

/** Recursively removes keys ending in `sig` / `signature` (authSig, keyGateSig, serverSignature, ...). */
export function sanitizeAuditSubject(
  subject: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(subject)) {
    if (SIGNATURE_KEY_RE.test(key)) continue;
    out[key] = sanitizeValue(value);
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && value !== null) {
    return sanitizeAuditSubject(value as Record<string, unknown>);
  }
  return value;
}

export async function writeAudit(db: Db, entry: AuditEntry): Promise<bigint> {
  const [row] = await db
    .insert(auditLog)
    .values({
      actor: entry.actor,
      action: entry.action,
      subject: sanitizeAuditSubject(entry.subject),
      outcome: entry.outcome,
      onchainRef: entry.onchainRef,
    })
    .returning({ id: auditLog.id });
  if (row === undefined) throw new Error("audit_log insert returned no row");
  return row.id;
}
