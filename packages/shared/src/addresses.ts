import type { Address } from "viem";
import { HEDERA_TESTNET_CHAIN_ID } from "./eip712";

/**
 * Deployed contract addresses. `apps/contracts/scripts/deploy.ts` writes the Testnet
 * values back into DEFAULT_DEPLOYMENT after `RightsNFT` / `RightsRegistry` are deployed
 * (tasks.md T047). Any runtime may override them through environment variables.
 * Payment asset is native HBAR, so there is no token address.
 */
export type Deployment = {
  chainId: number;
  rightsNFT: Address;
  rightsRegistry: Address;
};

export const ZERO_ADDRESS: Address =
  "0x0000000000000000000000000000000000000000";

/** @deploy-writeback:start */
export const DEFAULT_DEPLOYMENT: Deployment = {
  chainId: 296,
  rightsNFT: "0x3524049309DC3F7f1dE83a8687a55Afa927dAe7A",
  rightsRegistry: "0xf397F1C1697Fe777AEE97994a4b686519bD26877",
};
/** @deploy-writeback:end */

export type AddressEnv = {
  RIGHTS_NFT_ADDRESS?: string;
  RIGHTS_REGISTRY_ADDRESS?: string;
  HEDERA_CHAIN_ID?: string;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function pickAddress(
  value: string | undefined,
  fallback: Address,
  name: string,
): Address {
  if (value === undefined || value === "") return fallback;
  if (!ADDRESS_RE.test(value))
    throw new Error(`${name} is not a valid address`);
  return value as Address;
}

export function resolveDeployment(env: AddressEnv = {}): Deployment {
  const chainId =
    env.HEDERA_CHAIN_ID === undefined || env.HEDERA_CHAIN_ID === ""
      ? DEFAULT_DEPLOYMENT.chainId
      : Number.parseInt(env.HEDERA_CHAIN_ID, 10);
  if (Number.isNaN(chainId)) throw new Error("HEDERA_CHAIN_ID is not a number");
  return {
    chainId,
    rightsNFT: pickAddress(
      env.RIGHTS_NFT_ADDRESS,
      DEFAULT_DEPLOYMENT.rightsNFT,
      "RIGHTS_NFT_ADDRESS",
    ),
    rightsRegistry: pickAddress(
      env.RIGHTS_REGISTRY_ADDRESS,
      DEFAULT_DEPLOYMENT.rightsRegistry,
      "RIGHTS_REGISTRY_ADDRESS",
    ),
  };
}

export function isDeployed(deployment: Deployment): boolean {
  return (
    deployment.rightsNFT !== ZERO_ADDRESS &&
    deployment.rightsRegistry !== ZERO_ADDRESS
  );
}
