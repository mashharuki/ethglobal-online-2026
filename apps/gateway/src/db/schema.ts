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

// pending: a request holds (or held) the claim | settled: receipt on chain | failed: rejected
// before any value moved (the same payload may be retried)
export const PAYMENT_STATUSES = ["pending", "settled", "failed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
// how far the claim holder got: verify (nothing moved) -> settle (facilitator call in flight,
// outcome unknown if we crash) -> anchor (paid; receipt not yet on chain) -> done
export const PAYMENT_STAGES = ["verify", "settle", "anchor", "done"] as const;
export type PaymentStage = (typeof PAYMENT_STAGES)[number];

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
    // numeric is unconstrained in Postgres (accepts 1.5, -1, NaN, Infinity); epochs are
    // non-negative finite integers. `< 1e30` rejects NaN (sorts above everything) and Infinity.
    check(
      "wallet_blinded_shares_epoch_check",
      sql`${t.accessEpochAtGrant} IS NULL OR (${t.accessEpochAtGrant} >= 0 AND ${t.accessEpochAtGrant} < 1e30 AND ${t.accessEpochAtGrant} = trunc(${t.accessEpochAtGrant}))`,
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
    check("receipt_consumption_use_index_check", sql`${t.useIndex} >= 0`),
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
    stage: text("stage").$type<PaymentStage>().default("verify").notNull(),
    // set once the facilitator confirmed the payment; survives claim hand-overs
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // ownership token of the request working on this row (NULL = released); a claim older
    // than the lease may be taken over
    claimToken: bytea("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "payment_binding_status_check",
      sql`${t.status} IN ('pending', 'settled', 'failed')`,
    ),
    check(
      "payment_binding_stage_check",
      sql`${t.stage} IN ('verify', 'settle', 'anchor', 'done')`,
    ),
    // tinybar amount: non-negative finite integer (numeric would otherwise accept
    // 1.5 / -1 / NaN / Infinity; `< 1e30` rejects the last two)
    check(
      "payment_binding_amount_check",
      sql`${t.amount} >= 0 AND ${t.amount} < 1e30 AND ${t.amount} = trunc(${t.amount})`,
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

// MCP spend policy ledger (R-9): tinybar reserved per Mcp-Session-Id, added atomically before
// a purchase signs anything and only given back when no value can have moved.
export const mcpSessionSpend = pgTable(
  "mcp_session_spend",
  {
    sessionKey: bytea("session_key").primaryKey(),
    spentTinybar: numeric("spent_tinybar", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "mcp_session_spend_amount_check",
      sql`${t.spentTinybar} >= 0 AND ${t.spentTinybar} < 1e30 AND ${t.spentTinybar} = trunc(${t.spentTinybar})`,
    ),
  ],
);

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
