import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  customType,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { bytesToHex, type Hex, hexToBytes } from "viem";

/**
 * Gateway Postgres schema (tasks.md T074, data-model.md 2.3). Everything here is
 * NON-authoritative: concurrency control, key-share blinding, audit and cache only.
 * Authorization is always re-derived from chain reads (constitution II); the UNIQUE /
 * PRIMARY KEY constraints are the RDB layer of the exactly-once guarantees (constitution V).
 */
function toDriverBytes(value: Hex): Uint8Array {
  const bytes = hexToBytes(value);
  // postgres.js and pglite both serialize Buffer/Uint8Array as bytea.
  return typeof Buffer !== "undefined" ? Buffer.from(bytes) : bytes;
}

/** bytea <-> 0x-hex. Rows carry hex strings in TypeScript; the wire format is raw bytes. */
export const bytea = customType<{ data: Hex; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return toDriverBytes(value);
  },
  fromDriver(value) {
    return bytesToHex(value);
  },
});

export const BLINDED_SHARE_PATHS = ["owner", "licensee"] as const;
export type BlindedSharePath = (typeof BLINDED_SHARE_PATHS)[number];

export const CONSUMPTION_STATUSES = ["locked", "settled", "failed"] as const;
export type ConsumptionStatus = (typeof CONSUMPTION_STATUSES)[number];

export const PAYMENT_STATUSES = ["pending", "settled", "failed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const NONCE_PURPOSES = ["owner-access", "keygate-challenge"] as const;
export type NoncePurpose = (typeof NONCE_PURPOSES)[number];

export const walletBlindedShares = pgTable(
  "wallet_blinded_shares",
  {
    assetId: bytea("asset_id").notNull(),
    wallet: bytea("wallet").notNull(),
    path: text("path").$type<BlindedSharePath>().notNull(),
    // share_U XOR HKDF(sig_wallet); computed once per (asset, wallet, path) (R-1a)
    blindedU: bytea("blinded_u").notNull(),
    // owner path only; audit / UX, never authorization
    accessEpochAtGrant: numeric("access_epoch_at_grant", { mode: "bigint" }),
    // licensee path only
    receiptHash: bytea("receipt_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.assetId, t.wallet, t.path] }),
    check(
      "wallet_blinded_shares_path_check",
      sql`${t.path} IN ('owner', 'licensee')`,
    ),
  ],
);

export const receiptConsumption = pgTable(
  "receipt_consumption",
  {
    receiptHash: bytea("receipt_hash").notNull(),
    useIndex: integer("use_index").notNull(),
    wallet: bytea("wallet").notNull(),
    // consume tx hash, filled after confirmation
    onchainTx: bytea("onchain_tx"),
    status: text("status").$type<ConsumptionStatus>().notNull(),
    // settled + within 5 min => share_G may be re-delivered for the same use_index (FR-007)
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // constitution V: exactly one row per (receipt, useIndex)
    unique("receipt_consumption_receipt_hash_use_index_unique").on(
      t.receiptHash,
      t.useIndex,
    ),
    check(
      "receipt_consumption_status_check",
      sql`${t.status} IN ('locked', 'settled', 'failed')`,
    ),
  ],
);

export const paymentBinding = pgTable(
  "payment_binding",
  {
    // keccak of the buyer-signed X-PAYMENT payload (R-10): single-column PK
    paymentId: bytea("payment_id").primaryKey(),
    purchaseRequestHash: bytea("purchase_request_hash").notNull(),
    // filled after settle (NULL while pending)
    receiptHash: bytea("receipt_hash"),
    amount: numeric("amount", { mode: "bigint" }).notNull(),
    status: text("status").$type<PaymentStatus>().default("pending").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "payment_binding_status_check",
      sql`${t.status} IN ('pending', 'settled', 'failed')`,
    ),
  ],
);

export const authNonce = pgTable(
  "auth_nonce",
  {
    nonce: bytea("nonce").primaryKey(),
    wallet: bytea("wallet").notNull(),
    purpose: text("purpose").$type<NoncePurpose>().notNull(),
    chainId: integer("chain_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // set once on first use (FR-024)
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "auth_nonce_purpose_check",
      sql`${t.purpose} IN ('owner-access', 'keygate-challenge')`,
    ),
  ],
);

export const mcpSessionBinding = pgTable("mcp_session_binding", {
  receiptHash: bytea("receipt_hash").primaryKey(),
  mcpSessionId: bytea("mcp_session_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const AUDIT_ACTIONS = [
  "owner_keygate",
  "x402_settle",
  "consume",
  "deny",
  "claim",
  "policy_update",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
  actor: bytea("actor"),
  action: text("action").$type<AuditAction>().notNull(),
  subject: jsonb("subject").$type<Record<string, unknown>>().notNull(),
  // 'allow' | 'deny:<ErrorCode>'
  outcome: text("outcome").notNull(),
  onchainRef: bytea("onchain_ref"),
});

export const subgraphCache = pgTable("subgraph_cache", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
