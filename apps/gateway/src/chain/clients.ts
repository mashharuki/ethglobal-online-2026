import {
  type Deployment,
  isDeployed,
  resolveDeployment,
} from "@truenft/shared";
import {
  type Account,
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
  type HttpTransport,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Env } from "../env";

/**
 * viem clients for the Hedera JSON-RPC relay (tasks.md T071). The public client is the
 * authorization authority (every request re-reads chain state, constitution II); the wallet
 * client wraps HEDERA_OPERATOR_KEY and is only used through OperatorTxQueue (R-3a).
 */
type ChainReader = PublicClient<HttpTransport, Chain>;
export type OperatorWallet = WalletClient<HttpTransport, Chain, Account>;

export type ChainContext = {
  chain: Chain;
  deployment: Deployment;
  publicClient: ChainReader;
};

export function hederaChain(chainId: number, rpcUrl: string): Chain {
  const isTestnet = chainId === 296;
  return defineChain({
    id: chainId,
    name: isTestnet ? "Hedera Testnet" : `EVM chain ${chainId}`,
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: isTestnet
      ? { default: { name: "HashScan", url: "https://hashscan.io/testnet" } }
      : undefined,
  });
}

function parseChainId(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`HEDERA_CHAIN_ID is not a positive integer: ${value}`);
  }
  return parsed;
}

export function createChainContext(env: Env): ChainContext {
  const chainId = parseChainId(env.HEDERA_CHAIN_ID);
  const deployment = resolveDeployment({
    HEDERA_CHAIN_ID: env.HEDERA_CHAIN_ID,
    RIGHTS_NFT_ADDRESS: env.RIGHTS_NFT_ADDRESS,
    RIGHTS_REGISTRY_ADDRESS: env.RIGHTS_REGISTRY_ADDRESS,
  });
  if (deployment.chainId !== chainId) {
    throw new Error(
      `deployment chainId ${deployment.chainId} != HEDERA_CHAIN_ID ${chainId}`,
    );
  }
  const chain = hederaChain(chainId, env.HEDERA_RPC_URL);
  const publicClient = createPublicClient({
    chain,
    transport: http(env.HEDERA_RPC_URL, { timeout: 15_000, retryCount: 2 }),
  });
  return { chain, deployment, publicClient };
}

/** True when both contract addresses are configured for this chain (else reads are pointless). */
export function isChainConfigured(ctx: ChainContext): boolean {
  return isDeployed(ctx.deployment);
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** Operator wallet (consume / bumpLicenseEpoch). Never log the key; the account address is fine. */
export function createOperatorWallet(
  env: Env,
  ctx: ChainContext,
): OperatorWallet {
  const key = env.HEDERA_OPERATOR_KEY;
  if (key === undefined || key === "") {
    throw new Error("HEDERA_OPERATOR_KEY secret is not set");
  }
  if (!PRIVATE_KEY_RE.test(key)) {
    throw new Error(
      "HEDERA_OPERATOR_KEY must be a 0x-prefixed 32-byte hex key",
    );
  }
  return createWalletClient({
    account: privateKeyToAccount(key as Hex),
    chain: ctx.chain,
    transport: http(env.HEDERA_RPC_URL, { timeout: 15_000 }),
  });
}
