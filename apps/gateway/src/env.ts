import type {
  DurableObjectNamespace,
  Hyperdrive,
  KVNamespace,
} from "@cloudflare/workers-types";

/**
 * Worker bindings and variables (mirrors wrangler.toml). Secrets are listed in CONFIG.md.
 * Binding types are imported (not ambient) so modules that only need `Env` typecheck under
 * the node tsconfig too.
 */
export type SettlementMode = "primary" | "fallback" | "custodial";

export type Env = {
  // vars
  HEDERA_CHAIN_ID: string;
  HEDERA_RPC_URL: string;
  /** Hedera mirror node REST base (payer account id -> EVM address) */
  HEDERA_MIRROR_URL: string;
  X402_FACILITATOR_URL: string;
  PAYMENT_ASSET: "native";
  SETTLEMENT_MODE: SettlementMode;
  /** Hedera account id that receives HBAR on the custodial rail (R-2a third option) */
  SETTLEMENT_ACCOUNT_ID: string;
  SUBGRAPH_URL: string;
  /** Empty string = fall back to packages/shared DEFAULT_DEPLOYMENT (deploy write-back). */
  RIGHTS_NFT_ADDRESS: string;
  RIGHTS_REGISTRY_ADDRESS: string;
  /** HTTP gateway used to fetch ipfs:// manifests / content. */
  IPFS_GATEWAY_URL: string;
  /** Comma-separated browser origins allowed to call the public HTTP API. */
  CORS_ALLOWED_ORIGINS: string;
  /** MCP spend policy (R-9): hard cap per Mcp-Session-Id, tinybar */
  MCP_SESSION_SPEND_CAP_TINYBAR: string;
  /**
   * MCP OAuth remediation (specs/mcp-auth-remediation-plan.md). Per-principal daily spend
   * cap, enforced across every grant a principal holds (agent_principal_spend), tinybar.
   */
  MCP_PRINCIPAL_DAILY_CAP_TINYBAR: string;
  /** Default per-purchase / total budget / TTL a new agent_grant is created with, tinybar/seconds. */
  MCP_GRANT_DEFAULT_MAX_PER_PURCHASE_TINYBAR: string;
  MCP_GRANT_DEFAULT_TOTAL_BUDGET_TINYBAR: string;
  MCP_GRANT_DEFAULT_TTL_SEC: string;
  /** Balance pre-check margin above the quoted price (buyAccess), tinybar. */
  MCP_BALANCE_HEADROOM_TINYBAR: string;
  /** Privy `external_id` prefix for per-principal AI-delegated wallets. */
  PRIVY_AI_WALLET_EXTERNAL_ID_PREFIX: string;
  // secrets (wrangler secret put / .dev.vars)
  HEDERA_OPERATOR_KEY?: string;
  RECEIPT_SIGNER_KEY?: string;
  KV_KEK?: string;
  PRIVY_APP_ID?: string;
  PRIVY_APP_SECRET?: string;
  /**
   * @deprecated single shared Privy server wallet (pre-remediation). Kept defined (not
   * referenced by the MCP path once MCP_AUTH_REQUIRED=true) so existing wrangler secrets
   * are not invalidated; the wallet itself is never deleted or drained.
   */
  PRIVY_WALLET_ID?: string;
  /** @deprecated see PRIVY_WALLET_ID */
  PRIVY_WALLET_ADDRESS?: string;
  /**
   * P-256 authorization key (DER-encoded PKCS8 private key, base64) registered as a Privy
   * key quorum member (PRIVY_SIGNER_QUORUM_ID below) so the gateway can sign for a
   * per-principal delegated wallet without holding a user JWT (specs/mcp-auth-remediation-plan.md).
   */
  PRIVY_AUTHORIZATION_PRIVATE_KEY?: string;
  /** Privy key quorum id the gateway's authorization key belongs to (not secret - an id). */
  PRIVY_SIGNER_QUORUM_ID?: string;
  /** Per-asset share_U (owner path), loaded by scripts/load-shares.ts. */
  [shareU: `SHARE_U_${string}`]: string | undefined;
  // bindings
  SHARE_G: KVNamespace;
  HYPERDRIVE: Hyperdrive;
  RECEIPT_LOCK: DurableObjectNamespace;
  OPERATOR_TX_QUEUE: DurableObjectNamespace;
};

export function getChainId(env: Env): number {
  const parsed = Number.parseInt(env.HEDERA_CHAIN_ID, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`HEDERA_CHAIN_ID is not a number: ${env.HEDERA_CHAIN_ID}`);
  }
  return parsed;
}
