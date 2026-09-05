/**
 * Worker bindings and variables (mirrors wrangler.toml). Secrets are listed in CONFIG.md.
 */
type SettlementMode = "primary" | "fallback" | "custodial";

export type Env = {
  // vars
  HEDERA_CHAIN_ID: string;
  HEDERA_RPC_URL: string;
  X402_FACILITATOR_URL: string;
  PAYMENT_ASSET: "native";
  SETTLEMENT_MODE: SettlementMode;
  SUBGRAPH_URL: string;
  /** Empty string = fall back to packages/shared DEFAULT_DEPLOYMENT (deploy write-back). */
  RIGHTS_NFT_ADDRESS: string;
  RIGHTS_REGISTRY_ADDRESS: string;
  // secrets (wrangler secret put / .dev.vars)
  HEDERA_OPERATOR_KEY?: string;
  RECEIPT_SIGNER_KEY?: string;
  KV_KEK?: string;
  PRIVY_APP_ID?: string;
  PRIVY_APP_SECRET?: string;
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
