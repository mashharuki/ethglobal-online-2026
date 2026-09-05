import { isErrorCode } from "@truenft/shared";
import { and, desc, gte, type SQL, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { auditLog } from "../db/schema";
import { type AppEnv, badRequest, hex32 } from "./schemas";

/**
 * GET /audit (tasks.md T090, FR-023): allow / deny decisions, newest first. The response is
 * a strict allowlist (openapi AuditEntry) so signatures, shares or session tokens can never
 * leak through it even if a subject payload changes later.
 */
const Query = z.object({
  assetId: hex32.optional(),
  since: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

type AuditEntry = {
  id: string;
  at: number;
  action: string;
  outcome: "allow" | "deny";
  code?: string;
  assetId?: string;
  subject?: string;
  onchainRef?: string;
  detail?: {
    tokenId?: string;
    receiptHash?: string;
    paymentId?: string;
    useIndex?: number;
  };
};

function pickString(
  subject: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = subject[key];
  return typeof v === "string" ? v : undefined;
}

function toAuditEntry(row: typeof auditLog.$inferSelect): AuditEntry {
  const subject = row.subject;
  const attempted = pickString(subject, "attempted");
  const [outcome, code] = row.outcome.startsWith("deny:")
    ? ["deny" as const, row.outcome.slice("deny:".length)]
    : ["allow" as const, undefined];
  const useIndex = subject.useIndex;
  const entry: AuditEntry = {
    id: row.id.toString(),
    at: Math.floor(row.ts.getTime() / 1000),
    action:
      row.action === "deny" && attempted !== undefined ? attempted : row.action,
    outcome,
  };
  if (code !== undefined && isErrorCode(code)) entry.code = code;
  const assetId = pickString(subject, "assetId");
  if (assetId !== undefined) entry.assetId = assetId;
  if (row.actor !== null) entry.subject = row.actor;
  if (row.onchainRef !== null) entry.onchainRef = row.onchainRef;
  const detail: AuditEntry["detail"] = {};
  const tokenId = pickString(subject, "tokenId");
  if (tokenId !== undefined) detail.tokenId = tokenId;
  const receiptHash = pickString(subject, "receiptHash");
  if (receiptHash !== undefined) detail.receiptHash = receiptHash;
  const paymentId = pickString(subject, "paymentId");
  if (paymentId !== undefined) detail.paymentId = paymentId;
  if (typeof useIndex === "number") detail.useIndex = useIndex;
  if (Object.keys(detail).length > 0) entry.detail = detail;
  return entry;
}

export function registerAuditRoutes(app: Hono<AppEnv>): void {
  app.get("/audit", async (c) => {
    const services = c.get("services");
    const parsed = Query.safeParse({
      assetId: c.req.query("assetId"),
      since: c.req.query("since"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) throw badRequest("invalid query", parsed.error.issues);
    const { assetId, since, limit } = parsed.data;
    const filters: SQL[] = [];
    if (assetId !== undefined) {
      filters.push(
        sql`lower(${auditLog.subject}->>'assetId') = ${assetId.toLowerCase()}`,
      );
    }
    if (since !== undefined) {
      filters.push(gte(auditLog.ts, new Date(since * 1000)));
    }
    const rows = await services.db
      .select()
      .from(auditLog)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(desc(auditLog.ts), desc(auditLog.id))
      .limit(limit);
    return c.json(rows.map(toAuditEntry));
  });
}
