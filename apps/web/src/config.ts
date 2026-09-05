import { HEDERA_TESTNET_MIRROR_NODE_URL } from "@x402/hedera";

export type Config = {
  privyAppId: string;
  resourceServerUrl: string;
  mirrorNodeUrl: string;
};

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): Config {
  const privyAppId = env.VITE_PRIVY_APP_ID ?? "";
  if (privyAppId.length === 0) {
    throw new Error("VITE_PRIVY_APP_ID must be set.");
  }

  const resourceServerUrl = env.VITE_RESOURCE_SERVER_URL ?? "";
  try {
    new URL(resourceServerUrl);
  } catch {
    throw new Error("VITE_RESOURCE_SERVER_URL must be a valid URL.");
  }

  return {
    privyAppId,
    resourceServerUrl,
    mirrorNodeUrl: HEDERA_TESTNET_MIRROR_NODE_URL,
  };
}

let cached: Config | undefined;

export function getConfig(): Config {
  cached ??= loadConfig(import.meta.env as unknown as Env);
  return cached;
}
