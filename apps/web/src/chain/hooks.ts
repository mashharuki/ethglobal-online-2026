import { useWallets } from "@privy-io/react-auth";
import type { Deployment } from "@truenft/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { formatHbar } from "../components/formatHbar";
import { getConfig } from "../config";
import { resolveHederaAccount } from "../hedera/resolveAccount";
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

/**
 * Picks the user's primary embedded wallet, not "whichever `useWallets()` happens to list
 * first" - `useWallets()` order is not guaranteed stable once a second embedded wallet
 * exists (the MCP OAuth remediation provisions one AI-delegated wallet per principal
 * alongside the user's own browser wallet). The primary wallet is the one with the lowest
 * `walletIndex`; nullish or negative values (Privy's HD index is always a non-negative
 * integer, but this normalizes defensively rather than trusting that) are treated as 0, the
 * index of the very first HD wallet.
 */
function normalizedWalletIndex(walletIndex: number | null | undefined): number {
  return typeof walletIndex === "number" && walletIndex >= 0 ? walletIndex : 0;
}

export function selectPrimaryWallet<T extends { walletIndex?: number | null }>(
  wallets: readonly T[],
): T | undefined {
  return wallets.reduce<T | undefined>((primary, candidate) => {
    if (primary === undefined) return candidate;
    const primaryIndex = normalizedWalletIndex(primary.walletIndex);
    const candidateIndex = normalizedWalletIndex(candidate.walletIndex);
    return candidateIndex < primaryIndex ? candidate : primary;
  }, undefined);
}

export function useEmbeddedWallet(): EmbeddedWallet {
  const { ready, wallets } = useWallets();
  const embedded = selectPrimaryWallet(
    wallets.filter((w) => w.walletClientType === "privy"),
  );
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

const BALANCE_POLL_INTERVAL_MS = 15_000;

export type WalletBalanceStatus = "loading" | "ready" | "error";

/**
 * Pure formatting split out of `useWalletBalance` (same pattern as `selectPrimaryWallet`) so it
 * can be unit tested without rendering the hook. `balanceTinybars === undefined` while
 * `status === "ready"` means the Mirror Node has no account for this address yet (not funded /
 * lazy-created) - resolveHederaAccount's own `null` return, not an error.
 */
export function formatBalanceLabel(
  status: WalletBalanceStatus,
  balanceTinybars: bigint | undefined,
): string {
  if (status === "loading") return "…";
  if (status === "error") return "balance unavailable";
  return balanceTinybars === undefined ? "0 ℏ" : formatHbar(balanceTinybars);
}

type BalanceResult = {
  /** the address this result was fetched for. Belt-and-suspenders with the render-time reset
   * below (Codex review round 3): a request started for address A can still resolve in the
   * narrow window after a re-render already committed address B's reset (React's passive-effect
   * cleanup for A, which sets `cancelled`, has not run yet) - filtering by address at READ time
   * catches that window even though the render-time reset alone cannot. */
  address: Address;
  status: WalletBalanceStatus;
  balanceTinybars: bigint | undefined;
};

/**
 * The connected wallet's own HBAR balance, read straight from the Hedera Mirror Node (same
 * source Market.tsx's purchase flow already uses via `resolveHederaAccount`, just displayed
 * here instead of only being read internally). Polls every 15s so a purchase's effect on the
 * balance shows up without a page reload.
 */
export function useWalletBalance(address: Address | undefined): {
  status: WalletBalanceStatus;
  label: string;
} {
  // React's documented "adjust state during render" pattern (react.dev/learn/you-might-not-
  // need-an-effect#adjusting-some-state-when-a-prop-changes), not an extra effect: the instant
  // `address` differs from the last-seen value, reset `result` in the SAME render (React
  // discards this render and re-renders immediately, before paint) rather than one render later
  // via an effect. Codex review, 3 rounds: without this, switching wallets briefly shows the
  // PREVIOUS wallet's balance next to the NEW address (render-before-effect timing), and
  // returning to a PREVIOUSLY-SEEN address (A -> B -> A) would resurrect A's stale old result
  // instead of showing "loading" while it re-fetches. This alone doesn't close every window
  // (see `BalanceResult.address` above), so it's combined with address-tagging at read time.
  const [session, setSession] = useState(address);
  const [result, setResult] = useState<BalanceResult | undefined>(undefined);
  if (address !== session) {
    setSession(address);
    setResult(undefined);
  }

  useEffect(() => {
    if (address === undefined) return;
    let cancelled = false;
    // Codex review: two overlapping polls (a slow request outlasting the next 15s tick) could
    // otherwise land out of order and let an older response overwrite a newer one. Guard against
    // an OUT-OF-ORDER response (one older than whatever was last applied), not merely a response
    // that isn't the newest STARTED request - the latter would starve updates entirely whenever
    // every single fetch is slower than the poll interval (each response would always find a
    // newer one already in flight and get discarded, round 2 of this same review).
    let nextSeq = 0;
    let lastAppliedSeq = 0;
    const fetchBalance = async () => {
      const seq = ++nextSeq;
      try {
        const account = await resolveHederaAccount(
          address,
          getConfig().mirrorNodeUrl,
        );
        if (cancelled || seq <= lastAppliedSeq) return;
        lastAppliedSeq = seq;
        setResult({
          address,
          status: "ready",
          balanceTinybars: account?.balanceTinybars,
        });
      } catch {
        if (cancelled || seq <= lastAppliedSeq) return;
        lastAppliedSeq = seq;
        setResult({ address, status: "error", balanceTinybars: undefined });
      }
    };
    fetchBalance();
    const interval = setInterval(fetchBalance, BALANCE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [address]);

  const current = result?.address === address ? result : undefined;
  const status = current?.status ?? "loading";
  return {
    status,
    label: formatBalanceLabel(status, current?.balanceTinybars),
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
  /** the block every field above was read at */
  block: bigint;
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
  return { owner, creator, accessEpoch, licenseEpoch, block: blockNumber };
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
  // Read the actual minted ID from this transaction, not the earlier simulation: another
  // creator may have minted in between. Filter out logs emitted by other contracts.
  const minted = parseEventLogs({
    abi: rightsNftAbi,
    eventName: "Transfer",
    logs: receipt.logs,
  }).find(
    (log) => log.address.toLowerCase() === deployment.rightsNFT.toLowerCase(),
  );
  return { txHash, tokenId: minted?.args.tokenId };
}
