/**
 * Worker bindings and variables (mirrors wrangler.toml). Secrets are listed in SECRETS.md.
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
  // secrets
  HEDERA_OPERATOR_KEY?: string;
  RECEIPT_SIGNER_KEY?: string;
  KV_KEK?: string;
  PRIVY_APP_ID?: string;
  PRIVY_APP_SECRET?: string;
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
