import { type Deployment, resolveDeployment } from "@truenft/shared";
import { HEDERA_TESTNET_MIRROR_NODE_URL } from "@x402/hedera";

/**
 * Browser configuration (tasks.md T104). Everything comes from `VITE_*` variables; the
 * contract addresses default to the deploy write-back in packages/shared (T047).
 */
export type Config = {
  privyAppId: string;
  gatewayUrl: string;
  rpcUrl: string;
  mirrorNodeUrl: string;
  ipfsGatewayUrl: string;
  deployment: Deployment;
};

type Env = Record<string, string | undefined>;

const DEFAULT_RPC_URL = "https://testnet.hashio.io/api";
const DEFAULT_IPFS_GATEWAY = "https://ipfs.io";

function requireUrl(value: string | undefined, name: string): string {
  try {
    return new URL(value ?? "").toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

export function loadConfig(env: Env): Config {
  const privyAppId = env.VITE_PRIVY_APP_ID ?? "";
  if (privyAppId.length === 0) {
    throw new Error("VITE_PRIVY_APP_ID must be set.");
  }
  return {
    privyAppId,
    gatewayUrl: requireUrl(env.VITE_GATEWAY_URL, "VITE_GATEWAY_URL"),
    rpcUrl: requireUrl(
      env.VITE_HEDERA_RPC_URL ?? DEFAULT_RPC_URL,
      "VITE_HEDERA_RPC_URL",
    ),
    mirrorNodeUrl: HEDERA_TESTNET_MIRROR_NODE_URL,
    ipfsGatewayUrl: requireUrl(
      env.VITE_IPFS_GATEWAY_URL ?? DEFAULT_IPFS_GATEWAY,
      "VITE_IPFS_GATEWAY_URL",
    ),
    deployment: resolveDeployment({
      RIGHTS_NFT_ADDRESS: env.VITE_RIGHTS_NFT_ADDRESS,
      RIGHTS_REGISTRY_ADDRESS: env.VITE_RIGHTS_REGISTRY_ADDRESS,
      HEDERA_CHAIN_ID: env.VITE_HEDERA_CHAIN_ID,
    }),
  };
}

let cached: Config | undefined;

export function getConfig(): Config {
  cached ??= loadConfig(import.meta.env as unknown as Env);
  return cached;
}
