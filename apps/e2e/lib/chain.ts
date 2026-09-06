import {
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  type PublicClient,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import type { TestAccount } from "../wallets";

/** Direct Hedera reads / writes for the script-level E2E (tasks.md T058 / T101). */
const rightsNftAbi = parseAbi([
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function accessEpoch(uint256 tokenId) view returns (uint256)",
]);

const rightsRegistryAbi = parseAbi([
  "function licenseEpoch(uint256 tokenId) view returns (uint256)",
  "function claimable(address account) view returns (uint256)",
  "function claim()",
]);

export type Deployment = { rightsNFT: Address; rightsRegistry: Address };

export function deploymentFromProcess(): Deployment {
  const nft = process.env.RIGHTS_NFT_ADDRESS ?? "";
  const registry = process.env.RIGHTS_REGISTRY_ADDRESS ?? "";
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(nft) ||
    !/^0x[0-9a-fA-F]{40}$/.test(registry)
  ) {
    throw new Error("RIGHTS_NFT_ADDRESS / RIGHTS_REGISTRY_ADDRESS are not set");
  }
  return { rightsNFT: nft as Address, rightsRegistry: registry as Address };
}

export function publicClient(): PublicClient {
  return createPublicClient({
    chain: hederaTestnet,
    transport: http(
      process.env.HEDERA_RPC_URL ?? "https://testnet.hashio.io/api",
    ),
  });
}

export async function readEpochs(
  client: PublicClient,
  deployment: Deployment,
  tokenId: bigint,
): Promise<{ owner: Address; accessEpoch: bigint; licenseEpoch: bigint }> {
  const [owner, accessEpoch, licenseEpoch] = await Promise.all([
    client.readContract({
      address: deployment.rightsNFT,
      abi: rightsNftAbi,
      functionName: "ownerOf",
      args: [tokenId],
    }),
    client.readContract({
      address: deployment.rightsNFT,
      abi: rightsNftAbi,
      functionName: "accessEpoch",
      args: [tokenId],
    }),
    client.readContract({
      address: deployment.rightsRegistry,
      abi: rightsRegistryAbi,
      functionName: "licenseEpoch",
      args: [tokenId],
    }),
  ]);
  return { owner, accessEpoch, licenseEpoch };
}

/** `safeTransferFrom(from, to, tokenId)` signed by `from`; resolves once mined. */
export async function transferNft(
  client: PublicClient,
  deployment: Deployment,
  from: TestAccount,
  to: Address,
  tokenId: bigint,
): Promise<Hex> {
  const wallet = createWalletClient({
    account: privateKeyToAccount(from.privateKey),
    chain: hederaTestnet,
    transport: http(
      process.env.HEDERA_RPC_URL ?? "https://testnet.hashio.io/api",
    ),
  });
  const hash = await wallet.writeContract({
    address: deployment.rightsNFT,
    abi: rightsNftAbi,
    functionName: "safeTransferFrom",
    args: [from.address, to, tokenId],
  });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}
