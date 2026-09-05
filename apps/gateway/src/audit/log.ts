import type { ErrorCode } from "@truenft/shared";
import type { Hex } from "viem";
import { type AuditAction, auditLog } from "../db/schema";
import type { Db } from "../db/types";

/**
 * audit_log writer (tasks.md T079, FR-023). Every allow / deny decision on a key operation
 * is recorded with the on-chain reference when one exists. Signature values are never
 * stored (R-1a): keys that mention a signature AND values shaped like a secp256k1
 * signature are dropped before insert, recursively.
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

/** authSig, keyGateSig, serverSignature, signatures, signatureHex, sig, ... */
const SIGNATURE_KEY_RE = /sig|signature/i;
/** 65-byte (r,s,v) signature as 0x hex - dropped wherever it appears, whatever the key. */
const SIGNATURE_VALUE_RE = /^0x[0-9a-fA-F]{130}$/;

function isSignatureValue(value: unknown): boolean {
  return typeof value === "string" && SIGNATURE_VALUE_RE.test(value);
}

/** Removes signature keys / values recursively; bigints become decimal strings (jsonb). */
export function sanitizeAuditSubject(
  subject: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(subject)) {
    if (SIGNATURE_KEY_RE.test(key)) continue;
    if (isSignatureValue(value)) continue;
    out[key] = sanitizeValue(value);
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((v) => !isSignatureValue(v)).map(sanitizeValue);
  }
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
