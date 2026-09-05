import { useWallets } from "@privy-io/react-auth";
import type { Deployment } from "@truenft/shared";
import { useCallback, useMemo } from "react";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  type EIP1193Provider,
  type Hex,
  http,
  type PublicClient,
  parseEventLogs,
} from "viem";
import { hederaTestnet } from "viem/chains";
import { getConfig } from "../config";
import { rightsNftAbi, rightsRegistryAbi } from "./abi";

/**
 * Privy embedded wallet + viem (tasks.md T105). Reads go straight to the Hedera JSON-RPC relay
 * (the UI shows what the chain says, never what the gateway or the subgraph cached); writes and
 * signatures go through the wallet's EIP-1193 provider.
 */
export type TypedDataLike = {
  domain: Record<string, unknown>;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

export type Signers = {
  signTypedData(typedData: TypedDataLike): Promise<Hex>;
  signRawHash(hashHex: string): Promise<string>;
};

export type EmbeddedWallet = {
  ready: boolean;
  address: Address | undefined;
  getProvider(): Promise<EIP1193Provider>;
};

function serializeTypedData(typedData: TypedDataLike): string {
  return JSON.stringify(typedData, (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

export function useEmbeddedWallet(): EmbeddedWallet {
  const { ready, wallets } = useWallets();
  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const getProvider = useCallback(async (): Promise<EIP1193Provider> => {
    if (embedded === undefined) {
      throw new Error("Privy embedded wallet is not available");
    }
    return (await embedded.getEthereumProvider()) as EIP1193Provider;
  }, [embedded]);
  return {
    ready,
    address: embedded?.address as Address | undefined,
    getProvider,
  };
}

/** EIP-712 (auth challenges) and raw-hash (Hedera transaction) signatures from the wallet. */
export function useSigners(wallet: EmbeddedWallet): Signers {
  return useMemo(
    () => ({
      signTypedData: async (typedData) => {
        const provider = await wallet.getProvider();
        return (await provider.request({
          method: "eth_signTypedData_v4",
          params: [wallet.address as Address, serializeTypedData(typedData)],
        })) as Hex;
      },
      signRawHash: async (hashHex) => {
        const provider = await wallet.getProvider();
        return (await provider.request({
          // Privy-specific: sign a 32-byte digest without any prefix (Hedera body hash)
          method: "secp256k1_sign" as never,
          params: [hashHex] as never,
        })) as string;
      },
    }),
    [wallet],
  );
}

export function usePublicClient(): PublicClient {
  const rpcUrl = getConfig().rpcUrl;
  return useMemo(
    () => createPublicClient({ chain: hederaTestnet, transport: http(rpcUrl) }),
    [rpcUrl],
  );
}

export type Ownership = {
  owner: Address;
  creator: Address;
  accessEpoch: bigint;
  licenseEpoch: bigint;
};

/** One consistent snapshot of the rights state, read at a pinned block. */
export async function readOwnership(
  client: PublicClient,
  deployment: Deployment,
  tokenId: bigint,
): Promise<Ownership> {
  const blockNumber = await client.getBlockNumber();
  const [owner, creator, accessEpoch, licenseEpoch] = await Promise.all([
    client.readContract({
      address: deployment.rightsNFT,
      abi: rightsNftAbi,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber,
    }),
    client.readContract({
      address: deployment.rightsNFT,
      abi: rightsNftAbi,
      functionName: "creatorOf",
      args: [tokenId],
      blockNumber,
    }),
    client.readContract({
      address: deployment.rightsNFT,
      abi: rightsNftAbi,
      functionName: "accessEpoch",
      args: [tokenId],
      blockNumber,
    }),
    client.readContract({
      address: deployment.rightsRegistry,
      abi: rightsRegistryAbi,
      functionName: "licenseEpoch",
      args: [tokenId],
      blockNumber,
    }),
  ]);
  return { owner, creator, accessEpoch, licenseEpoch };
}

async function walletClientFor(wallet: EmbeddedWallet) {
  if (wallet.address === undefined) {
    throw new Error("wallet is not connected");
  }
  return createWalletClient({
    account: wallet.address,
    chain: hederaTestnet,
    transport: custom(await wallet.getProvider()),
  });
}

/** `safeTransferFrom(owner, to, tokenId)` signed by the embedded wallet; returns the tx hash. */
export async function transferToken(
  wallet: EmbeddedWallet,
  deployment: Deployment,
  to: Address,
  tokenId: bigint,
): Promise<Hex> {
  const client = await walletClientFor(wallet);
  return client.writeContract({
    address: deployment.rightsNFT,
    abi: rightsNftAbi,
    functionName: "safeTransferFrom",
    args: [wallet.address as Address, to, tokenId],
  });
}

export type MintInput = {
  policyHash: Hex;
  assetId: Hex;
  contentHash: Hex;
  manifestURI: string;
};

/** `mint(to = creator = wallet)`; the tokenId comes from the Transfer log of the receipt. */
export async function mintToken(
  wallet: EmbeddedWallet,
  publicClient: PublicClient,
  deployment: Deployment,
  input: MintInput,
): Promise<{ txHash: Hex; tokenId: bigint | undefined }> {
  const client = await walletClientFor(wallet);
  const creator = wallet.address as Address;
  const txHash = await client.writeContract({
    address: deployment.rightsNFT,
    abi: rightsNftAbi,
    functionName: "mint",
    args: [
      creator,
      creator,
      input.policyHash,
      input.assetId,
      input.contentHash,
      input.manifestURI,
    ],
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  const minted = parseEventLogs({
    abi: rightsNftAbi,
    eventName: "Transfer",
    logs: receipt.logs,
  }).find(
    (log) => log.address.toLowerCase() === deployment.rightsNFT.toLowerCase(),
  );
  return { txHash, tokenId: minted?.args.tokenId };
}
