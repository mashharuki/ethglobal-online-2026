import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  customType,
  type ExtraConfigColumn,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytesToHex, type Hex, hexToBytes } from "viem";

/**
 * Gateway Postgres schema (tasks.md T074, data-model.md 2.3). Everything here is
 * NON-authoritative: concurrency control, key-share blinding, audit and cache only.
 * Authorization is always re-derived from chain reads (constitution II); the UNIQUE /
 * PRIMARY KEY constraints are the RDB layer of the exactly-once guarantees (constitution V).
 */
/**
 * These tables are internal gateway bookkeeping, never queried directly by an end user
 * (all access is mediated by the Worker's own application code - constitution II, "Authorization
 * is always re-derived from chain reads" above). RLS is enabled to satisfy the hosting
 * provider's "unrestricted table" advisory, not to isolate per-tenant rows.
 *
 * `to: "public"` means every Postgres role, not the `public` schema - this grants no
 * privileges by itself (a role still needs the usual GRANT to touch a table at all), it only
 * stops RLS from filtering rows for whichever role a GRANT already lets through. Table owners
 * and superuser/BYPASSRLS roles always bypass RLS regardless of policy. Without any policy at
 * all, RLS is fail-closed by default (see migrations/0003_enable_gateway_rls.sql): SELECT
 * silently returns zero rows and INSERT/UPDATE/DELETE fail with an explicit "row-level
 * security policy" error - either way, every query breaks the moment the gateway connects as
 * anything but the owning role. A narrower policy scoped to one named, non-login group role
 * (with the runtime login granted membership) would be tighter than "any role that has a
 * GRANT" - not done here since the actual Hyperdrive-side role name isn't known yet; revisit
 * once it is.
 */
function permissiveServiceAccessPolicy() {
  return pgPolicy("gateway_service_access", {
    for: "all",
    to: "public",
    using: sql`true`,
    withCheck: sql`true`,
  });
}

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
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

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
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

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
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

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
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

export const mcpSessionBinding = pgTable(
  "mcp_session_binding",
  {
    receiptHash: bytea("receipt_hash").primaryKey(),
    mcpSessionId: bytea("mcp_session_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // MCP OAuth remediation (specs/mcp-auth-remediation-plan.md, additive/nullable so
    // pre-remediation rows stay valid audit history and are never reassigned to a
    // principal - see the "legacy anonymous session" note on mcpAuthenticatedSession
    // below). An authenticated caller must present all four matching, so a legacy NULL
    // row is rejected for everyone rather than adopted.
    principalId: text("principal_id"),
    grantId: uuid("grant_id"),
    walletId: uuid("wallet_id"),
    // the on-chain licensee of this Receipt, snapshotted at purchase time - kept
    // separate from walletId because a wallet could in principle be re-provisioned for
    // the same principal later, but the licensee of an already-issued Receipt must not
    // retroactively change with it
    licensee: bytea("licensee"),
  },
  (t) => [
    index("mcp_session_binding_principal_idx").on(t.principalId),
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

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
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

export const AUDIT_ACTIONS = [
  "owner_keygate",
  "x402_settle",
  "consume",
  "deny",
  "claim",
  "policy_update",
  "delegation_revoke",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).defaultNow().notNull(),
    actor: bytea("actor"),
    action: text("action").$type<AuditAction>().notNull(),
    subject: jsonb("subject").$type<Record<string, unknown>>().notNull(),
    // 'allow' | 'deny:<ErrorCode>'
    outcome: text("outcome").notNull(),
    onchainRef: bytea("onchain_ref"),
  },
  () => [permissiveServiceAccessPolicy()],
).enableRLS();

export const subgraphCache = pgTable(
  "subgraph_cache",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").$type<unknown>().notNull(),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  () => [permissiveServiceAccessPolicy()],
).enableRLS();

/**
 * MCP OAuth 2.1 remediation (specs/mcp-auth-remediation-plan.md). Everything below layers
 * per-user OAuth identity + per-user delegated AI wallets + per-user spend budgets on top
 * of the existing session/spend tables above, rather than replacing them - the existing
 * mcpSessionBinding/mcpSessionSpend keep working as a secondary, session-scoped brake.
 *
 * No table below uses a foreign key, matching every table above: authorization is always
 * re-derived from a live read of these rows at request time (constitution II), never
 * inferred from referential integrity, so a dangling id is treated the same as a missing
 * grant/wallet (fail closed) rather than being prevented at the schema level.
 */
export const WALLET_PURPOSES = ["mcp-agent"] as const;
export type WalletPurpose = (typeof WALLET_PURPOSES)[number];

export const WALLET_PROVISIONING_STATES = [
  "pending",
  "active",
  "failed",
  "retired",
] as const;
export type WalletProvisioningState =
  (typeof WALLET_PROVISIONING_STATES)[number];

export const WALLET_SIGNER_STATES = [
  "none",
  "attach_pending",
  "attached",
  "removal_pending",
  "removed",
] as const;
export type WalletSignerState = (typeof WALLET_SIGNER_STATES)[number];

export const DELEGATION_SHAPES = ["additional-signer", "owner-quorum"] as const;
export type DelegationShape = (typeof DELEGATION_SHAPES)[number];

export const GRANT_STATES = ["active", "revoked", "expired"] as const;
export type GrantState = (typeof GRANT_STATES)[number];

export const SPEND_RESERVATION_STATES = [
  "reserved",
  "committed",
  "released",
] as const;
export type SpendReservationState = (typeof SPEND_RESERVATION_STATES)[number];

export const OAUTH_CLIENT_SOURCES = ["dcr", "preregistered"] as const;
export type OauthClientSource = (typeof OAUTH_CLIENT_SOURCES)[number];

export const OAUTH_REQUEST_STATUSES = [
  "pending",
  "consented",
  "denied",
  "exchanged",
] as const;
export type OauthRequestStatus = (typeof OAUTH_REQUEST_STATUSES)[number];

export const OAUTH_TOKEN_KINDS = ["access", "refresh"] as const;
export type OauthTokenKind = (typeof OAUTH_TOKEN_KINDS)[number];

/** a non-negative, finite, integer tinybar amount (the pattern every amount column below shares) */
function tinybarCheck(name: string, column: ExtraConfigColumn) {
  return check(
    name,
    sql`${column} >= 0 AND ${column} < 1e30 AND ${column} = trunc(${column})`,
  );
}

// One AI-delegated wallet per (principal, purpose). Provisioned at consent time (never
// lazily on first purchase) so the consent screen can show its address/balance and the
// user can fund it before any purchase is attempted.
export const agentWalletBinding = pgTable(
  "agent_wallet_binding",
  {
    id: uuid("id").primaryKey(),
    // verified Privy user id (e.g. "did:privy:..."). Opaque identifier only - never an
    // email or other PII (specs/mcp-auth-remediation-plan.md).
    principalId: text("principal_id").notNull(),
    purpose: text("purpose")
      .$type<WalletPurpose>()
      .default("mcp-agent")
      .notNull(),
    chainType: text("chain_type").notNull(),
    chainId: integer("chain_id").notNull(),
    delegationShape: text("delegation_shape")
      .$type<DelegationShape>()
      .notNull(),
    // write-once dedupe token set as the Privy external_id
    externalId: text("external_id").notNull(),
    // idempotency key handed to POST /v1/wallets; stable across a crashed-and-resumed
    // provisioning attempt so a retry cannot create a second Privy wallet
    provisioningKey: text("provisioning_key").notNull(),
    walletEpoch: integer("wallet_epoch").default(0).notNull(),
    provisioningState: text("provisioning_state")
      .$type<WalletProvisioningState>()
      .default("pending")
      .notNull(),
    // null until provisioning completes
    privyWalletId: text("privy_wallet_id"),
    address: bytea("address"),
    // compressed secp256k1 public key when Privy returns one (removes the need for a
    // dedicated probe signature to recover it)
    publicKey: bytea("public_key"),
    // cached mirror-node account id; advisory only, re-read before every purchase
    hederaAccountId: text("hedera_account_id"),
    signerQuorumId: text("signer_quorum_id"),
    signerState: text("signer_state")
      .$type<WalletSignerState>()
      .default("none")
      .notNull(),
    ownerVerifiedAt: timestamp("owner_verified_at", { withTimezone: true }),
    attempts: integer("attempts").default(0).notNull(),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // at most one non-retired wallet per (principal, purpose); a retired row steps aside
    // so re-provisioning after an explicit retire is possible
    uniqueIndex("agent_wallet_binding_principal_live_unique")
      .on(t.principalId, t.purpose)
      .where(sql`${t.provisioningState} <> 'retired'`),
    // a Privy wallet is never shared across principals
    uniqueIndex("agent_wallet_binding_privy_wallet_unique").on(t.privyWalletId),
    uniqueIndex("agent_wallet_binding_address_unique").on(t.address),
    uniqueIndex("agent_wallet_binding_external_id_unique").on(t.externalId),
    index("agent_wallet_binding_principal_idx").on(t.principalId),
    check(
      "agent_wallet_binding_purpose_check",
      sql`${t.purpose} IN ('mcp-agent')`,
    ),
    check(
      "agent_wallet_binding_chain_type_check",
      sql`${t.chainType} IN ('ethereum')`,
    ),
    check(
      "agent_wallet_binding_state_check",
      sql`${t.provisioningState} IN ('pending', 'active', 'failed', 'retired')`,
    ),
    check(
      "agent_wallet_binding_signer_state_check",
      sql`${t.signerState} IN ('none', 'attach_pending', 'attached', 'removal_pending', 'removed')`,
    ),
    check(
      "agent_wallet_binding_shape_check",
      sql`${t.delegationShape} IN ('additional-signer', 'owner-quorum')`,
    ),
    // an "active" row is always fully populated and owner-verified - a half-provisioned
    // wallet cannot be marked active even by a logic bug, only by a schema-level violation
    check(
      "agent_wallet_binding_active_complete_check",
      sql`${t.provisioningState} <> 'active' OR (${t.privyWalletId} IS NOT NULL AND ${t.address} IS NOT NULL AND ${t.ownerVerifiedAt} IS NOT NULL AND ${t.signerQuorumId} IS NOT NULL)`,
    ),
    check(
      "agent_wallet_binding_address_len_check",
      sql`${t.address} IS NULL OR octet_length(${t.address}) = 20`,
    ),
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

// The delegation + budget record an OAuth grant is bound to. principalId × clientId has at
// most one live (state='active') row: re-consent raises the ceiling via an upsert, never a
// second grant (specs/mcp-auth-remediation-plan.md completion condition: distinct
// principals must resolve to distinct wallets/licensee addresses, never a shared budget).
export const agentGrant = pgTable(
  "agent_grant",
  {
    id: uuid("id").primaryKey(),
    principalId: text("principal_id").notNull(),
    walletId: uuid("wallet_id").notNull(),
    clientId: text("client_id").notNull(),
    scope: text("scope").notNull(),
    chainId: integer("chain_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    totalBudgetTinybar: numeric("total_budget_tinybar", {
      mode: "bigint",
    }).notNull(),
    maxPerPurchaseTinybar: numeric("max_per_purchase_tinybar", {
      mode: "bigint",
    }).notNull(),
    reservedTinybar: numeric("reserved_tinybar", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    spentTinybar: numeric("spent_tinybar", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    state: text("state").$type<GrantState>().default("active").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    // bumped on every state change; the decrypt_content two-checkpoint revocation re-check
    // compares this to detect a revoke that landed mid-flight
    revision: numeric("revision", { mode: "bigint" }).default(sql`0`).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("agent_grant_live_principal_client_unique")
      .on(t.principalId, t.clientId)
      .where(sql`${t.state} = 'active'`),
    index("agent_grant_principal_state_idx").on(t.principalId, t.state),
    index("agent_grant_wallet_idx").on(t.walletId),
    check(
      "agent_grant_state_check",
      sql`${t.state} IN ('active', 'revoked', 'expired')`,
    ),
    check(
      "agent_grant_scope_check",
      sql`${t.scope} ~ '^[a-z]+:[a-z]+( [a-z]+:[a-z]+)*$'`,
    ),
    tinybarCheck("agent_grant_total_budget_check", t.totalBudgetTinybar),
    check(
      "agent_grant_max_per_purchase_check",
      sql`${t.maxPerPurchaseTinybar} > 0 AND ${t.maxPerPurchaseTinybar} < 1e30 AND ${t.maxPerPurchaseTinybar} = trunc(${t.maxPerPurchaseTinybar}) AND ${t.maxPerPurchaseTinybar} <= ${t.totalBudgetTinybar}`,
    ),
    tinybarCheck("agent_grant_reserved_check", t.reservedTinybar),
    tinybarCheck("agent_grant_spent_check", t.spentTinybar),
    // the overspend guard: an over-budget row cannot exist even if application logic is wrong
    check(
      "agent_grant_budget_envelope_check",
      sql`${t.reservedTinybar} + ${t.spentTinybar} <= ${t.totalBudgetTinybar}`,
    ),
    check(
      "agent_grant_revoked_consistency_check",
      sql`(${t.state} <> 'revoked') OR ${t.revokedAt} IS NOT NULL`,
    ),
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

// principal × UTC-day daily spend cap, enforced ACROSS every grant the principal holds
// (not per-grant) - this is what makes "open two OAuth grants to double the budget"
// impossible. Keyed by (principal_id, utc_day), deliberately NOT grant-scoped.
export const agentPrincipalSpend = pgTable(
  "agent_principal_spend",
  {
    principalId: text("principal_id").notNull(),
    // server UTC calendar day; snapshotted into dailyCapTinybar at first insert so a
    // mid-day env change cannot retroactively widen a day already in progress
    utcDay: text("utc_day").notNull(),
    dailyCapTinybar: numeric("daily_cap_tinybar", { mode: "bigint" }).notNull(),
    reservedTinybar: numeric("reserved_tinybar", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    spentTinybar: numeric("spent_tinybar", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.principalId, t.utcDay] }),
    tinybarCheck("agent_principal_spend_cap_check", t.dailyCapTinybar),
    tinybarCheck("agent_principal_spend_reserved_check", t.reservedTinybar),
    tinybarCheck("agent_principal_spend_spent_check", t.spentTinybar),
    check(
      "agent_principal_spend_envelope_check",
      sql`${t.reservedTinybar} + ${t.spentTinybar} <= ${t.dailyCapTinybar}`,
    ),
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

// The reserve -> commit|release ledger a purchase writes through before it ever signs a
// payment (specs/mcp-auth-remediation-plan.md §4): the budget/daily-cap gate is checked
// and reserved atomically, before any x402 payload exists, so 20 concurrent purchases
// against a small budget can never sum to more than the budget allows.
export const agentSpendReservation = pgTable(
  "agent_spend_reservation",
  {
    id: uuid("id").primaryKey(),
    principalId: text("principal_id").notNull(),
    grantId: uuid("grant_id").notNull(),
    walletId: uuid("wallet_id").notNull(),
    // the agent_principal_spend row this reservation debited - commit/release must hit the
    // SAME row even if settlement straddles UTC midnight
    utcDay: text("utc_day").notNull(),
    // the mcp_session_spend row this reservation also debited (existing session-scoped cap)
    mcpSessionKey: bytea("mcp_session_key").notNull(),
    assetId: bytea("asset_id").notNull(),
    amountTinybar: numeric("amount_tinybar", { mode: "bigint" }).notNull(),
    state: text("state")
      .$type<SpendReservationState>()
      .default("reserved")
      .notNull(),
    // filled the instant the X-PAYMENT payload exists; links to payment_binding.payment_id.
    // Deliberately not a foreign key: the reservation is written before the binding row
    // exists, and this table has no FKs at all (see the module comment above).
    paymentId: bytea("payment_id"),
    receiptHash: bytea("receipt_hash"),
    // recovery info: the last observed payment_binding status/stage, used to classify an
    // interrupted reservation without re-deriving it from scratch
    lastBindingStatus: text("last_binding_status"),
    lastBindingStage: text("last_binding_stage"),
    // stale-sweep horizon; a reservation is only ever auto-released once the linked
    // payment_binding proves nothing moved, never merely because this expired
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("agent_spend_reservation_payment_id_unique").on(t.paymentId),
    index("agent_spend_reservation_grant_state_idx").on(t.grantId, t.state),
    index("agent_spend_reservation_sweep_idx").on(t.state, t.expiresAt),
    index("agent_spend_reservation_principal_day_idx").on(
      t.principalId,
      t.utcDay,
    ),
    check(
      "agent_spend_reservation_state_check",
      sql`${t.state} IN ('reserved', 'committed', 'released')`,
    ),
    check(
      "agent_spend_reservation_amount_check",
      sql`${t.amountTinybar} > 0 AND ${t.amountTinybar} < 1e30 AND ${t.amountTinybar} = trunc(${t.amountTinybar})`,
    ),
    // a terminal state carries its timestamp and nothing else does: a row that IS
    // committed/released is always internally consistent. This does NOT by itself stop a
    // row from being moved a second time (e.g. committed -> released, or released twice
    // with settled_at cleared) - a single-row CHECK cannot express "this column may only
    // transition away from 'reserved' once" across successive UPDATEs. That exactly-once
    // guarantee is enforced at the application layer instead: every settlement/release
    // statement is `UPDATE ... WHERE state = 'reserved'` (mcp/spend.ts, Phase 4) - a row
    // that already left 'reserved' matches zero rows and the caller no-ops. This mirrors
    // the no-trigger convention already used by every other table in this file (e.g.
    // payment_binding's claim/lease fields have the same "CHECK for shape, CAS for
    // exactly-once" split); a real one-way state-machine trigger was considered and
    // rejected as disproportionate complexity for this codebase.
    check(
      "agent_spend_reservation_settled_consistency_check",
      sql`(${t.state} = 'committed') = (${t.settledAt} IS NOT NULL)`,
    ),
    check(
      "agent_spend_reservation_released_consistency_check",
      sql`(${t.state} = 'released') = (${t.releasedAt} IS NOT NULL)`,
    ),
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

// Which principal/grant/wallet an OAuth-authenticated Mcp-Session-Id belongs to. A
// self-describing signed token cannot be invalidated server-side; this row can - both
// per-grant revoke (specs/mcp-auth-remediation-plan.md §7) and the "invalidate every
// pre-remediation anonymous session" cutover (§8) are expressed as "no matching row here".
export const mcpAuthenticatedSession = pgTable(
  "mcp_authenticated_session",
  {
    // keccak256 of the verified session identity - same derivation as mcp/session.ts
    sessionKey: bytea("session_key").primaryKey(),
    principalId: text("principal_id").notNull(),
    grantId: uuid("grant_id").notNull(),
    walletId: uuid("wallet_id").notNull(),
    clientId: text("client_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("mcp_authenticated_session_principal_idx").on(t.principalId),
    index("mcp_authenticated_session_grant_idx").on(t.grantId),
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

// DCR-registered or pre-registered OAuth clients (RFC 7591). Every client is a "none"
// (public, no secret) auth method except the one pre-registered CI client, which gets a
// non-rotating refresh token instead of a new grant type (specs/mcp-auth-remediation-plan.md
// CI section) - refreshRotationDisabled is the only per-client authority this widens.
export const oauthClient = pgTable(
  "oauth_client",
  {
    clientId: text("client_id").primaryKey(),
    clientName: text("client_name").notNull(),
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method")
      .default("none")
      .notNull(),
    // advisory only; the authoritative scope check is always the grant's own `scope`
    scope: text("scope"),
    source: text("source").$type<OauthClientSource>().notNull(),
    // true only for the single pre-registered CI client (specs/mcp-auth-remediation-plan.md):
    // its refresh token is reused indefinitely on refresh instead of rotating, since CI has
    // no safe way to persist a newly-rotated token back to itself between runs
    refreshRotationDisabled: boolean("refresh_rotation_disabled")
      .default(false)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "oauth_client_source_check",
      sql`${t.source} IN ('dcr', 'preregistered')`,
    ),
    check(
      "oauth_client_auth_method_check",
      sql`${t.tokenEndpointAuthMethod} = 'none'`,
    ),
    check(
      "oauth_client_redirect_uris_check",
      sql`jsonb_array_length(${t.redirectUris}) > 0`,
    ),
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

// A parked /authorize request, resolved by the consent screen. requestIdHash is the
// SHA-256 of the opaque id handed to the browser - the raw id is never stored, so a leaked
// row cannot itself be replayed as a request_id.
export const oauthAuthorizationRequest = pgTable(
  "oauth_authorization_request",
  {
    requestIdHash: bytea("request_id_hash").primaryKey(),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource").notNull(),
    state: text("state"),
    status: text("status")
      .$type<OauthRequestStatus>()
      .default("pending")
      .notNull(),
    // set only once a verified Privy consent resolves it
    principalId: text("principal_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    index("oauth_authorization_request_expires_idx").on(t.expiresAt),
    check(
      "oauth_authorization_request_challenge_method_check",
      sql`${t.codeChallengeMethod} = 'S256'`,
    ),
    check(
      "oauth_authorization_request_status_check",
      sql`${t.status} IN ('pending', 'consented', 'denied', 'exchanged')`,
    ),
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

// A one-time-use authorization code (RFC 6749 §4.1.2). usedAt is burned atomically by a
// conditional UPDATE before any token is issued; a reuse (0 rows updated) revokes the
// whole token family (OAuth 2.1 §4.1.3 replay response).
export const oauthAuthorizationCode = pgTable(
  "oauth_authorization_code",
  {
    codeHash: bytea("code_hash").primaryKey(),
    requestIdHash: bytea("request_id_hash").notNull(),
    clientId: text("client_id").notNull(),
    principalId: text("principal_id").notNull(),
    grantId: uuid("grant_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("oauth_authorization_code_request_unique").on(t.requestIdHash),
    index("oauth_authorization_code_grant_idx").on(t.grantId),
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();

// Opaque access/refresh tokens (never JWT - only an opaque token backed by this table
// gives immediate revocation, specs/mcp-auth-remediation-plan.md). tokenHash is
// sha256(token); replacedBy chains a rotated refresh token to its successor so a replay of
// an already-rotated token can be detected and the whole family revoked.
export const oauthToken = pgTable(
  "oauth_token",
  {
    tokenHash: bytea("token_hash").primaryKey(),
    kind: text("kind").$type<OauthTokenKind>().notNull(),
    grantId: uuid("grant_id").notNull(),
    clientId: text("client_id").notNull(),
    principalId: text("principal_id").notNull(),
    scope: text("scope").notNull(),
    // RFC 8707 resource indicator this token is scoped to (the audience check)
    resource: text("resource").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedBy: bytea("replaced_by"),
  },
  (t) => [
    index("oauth_token_grant_idx").on(t.grantId),
    index("oauth_token_expires_idx").on(t.expiresAt),
    check("oauth_token_kind_check", sql`${t.kind} IN ('access', 'refresh')`),
    permissiveServiceAccessPolicy(),
  ],
).enableRLS();
