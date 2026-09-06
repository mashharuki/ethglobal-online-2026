import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import { useGateway } from "../app/gateway";
import { rightsNftAbi } from "../chain/abi";
import { mintToken, useEmbeddedWallet, usePublicClient } from "../chain/hooks";
import ErrorNote from "../components/ErrorNote";
import {
  buildManifest,
  contentHashOf,
  encryptDataset,
  type ManifestDraft,
  sharesArtifact,
  splitKey,
} from "../creator/prepare";
import { downloadBytes } from "../lib/download";

/**
 * Creator console (tasks.md T110): encrypt in the browser -> split K -> predict the tokenId ->
 * build + validate the Rights Manifest -> (creator uploads blob + manifest to IPFS) -> mint.
 * The shares never touch the gateway from here: they go to the operator's load-shares script.
 */
type Prepared = {
  blob: Uint8Array;
  contentHash: Hex;
  shares: { shareG: Uint8Array; shareU: Uint8Array };
};

export default function Creator() {
  const { config } = useGateway();
  const wallet = useEmbeddedWallet();
  const publicClient = usePublicClient();
  const [prepared, setPrepared] = useState<Prepared | undefined>();
  const [draft, setDraft] = useState<
    Omit<
      ManifestDraft,
      "chainId" | "nftContract" | "rightsRegistry" | "contentHash"
    >
  >({
    name: "dataset-1",
    previewURI: "",
    encryptedContentURI: "",
    priceHbar: "5",
    durationSec: 300,
    maxUses: 5,
    transferMode: "SURVIVE_TRANSFER",
    permissions: {
      commercialUse: true,
      aiTraining: false,
      derivativeGeneration: true,
    },
    creatorBps: 3000,
  });
  const [tokenId, setTokenId] = useState<string | undefined>();
  const [manifestURI, setManifestURI] = useState("");
  const [minted, setMinted] = useState<
    { txHash: Hex; tokenId?: bigint } | undefined
  >();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState<string | undefined>();

  // the two shares together are the content key: they leave memory with the component
  useEffect(
    () => () => {
      prepared?.shares.shareG.fill(0);
      prepared?.shares.shareU.fill(0);
    },
    [prepared],
  );

  const fullDraft = useCallback(
    (contentHash: Hex): ManifestDraft => ({
      ...draft,
      chainId: config.deployment.chainId,
      nftContract: config.deployment.rightsNFT,
      rightsRegistry: config.deployment.rightsRegistry,
      contentHash,
    }),
    [draft, config.deployment],
  );

  const onFile = useCallback(async (file: File) => {
    setError(undefined);
    try {
      const { key, blob } = await encryptDataset(
        new Uint8Array(await file.arrayBuffer()),
      );
      const shares = splitKey(key);
      key.fill(0);
      setPrepared({ blob, contentHash: contentHashOf(blob), shares });
    } catch (e) {
      setError(e);
    }
  }, []);

  const simulateNextTokenId = useCallback(async (): Promise<string> => {
    if (prepared === undefined || wallet.address === undefined) {
      throw new Error("encrypt a dataset and connect a wallet first");
    }
    const built = buildManifest(fullDraft(prepared.contentHash), "0");
    const { result } = await publicClient.simulateContract({
      account: wallet.address,
      address: config.deployment.rightsNFT,
      abi: rightsNftAbi,
      functionName: "mint",
      args: [
        wallet.address,
        wallet.address,
        built.policyHash,
        built.assetId,
        prepared.contentHash,
        "ipfs://pending",
      ],
    });
    return result.toString();
  }, [
    config.deployment.rightsNFT,
    fullDraft,
    prepared,
    publicClient,
    wallet.address,
  ]);

  const predictTokenId = useCallback(async () => {
    setError(undefined);
    setBusy("simulating mint to learn the next tokenId…");
    try {
      setTokenId(await simulateNextTokenId());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  }, [simulateNextTokenId]);

  const artifacts = useCallback(() => {
    if (prepared === undefined || tokenId === undefined) return;
    try {
      const built = buildManifest(fullDraft(prepared.contentHash), tokenId);
      downloadBytes("content.enc", prepared.blob);
      downloadBytes(
        "manifest.json",
        JSON.stringify(built.manifest, null, 2),
        "application/json",
      );
      downloadBytes(
        "shares.json",
        sharesArtifact({ assetId: built.assetId, ...prepared.shares }),
        "application/json",
      );
    } catch (e) {
      setError(e);
    }
  }, [fullDraft, prepared, tokenId]);

  const mint = useCallback(async () => {
    if (prepared === undefined || tokenId === undefined) return;
    setError(undefined);
    setBusy("re-checking the next tokenId → mint → waiting for the receipt…");
    try {
      // the manifest already on IPFS names `tokenId`; a mint by someone else since the
      // prediction would give this asset another id and break the manifest binding, so the
      // simulation is repeated right before signing and the minted id is compared afterwards
      const next = await simulateNextTokenId();
      if (next !== tokenId) {
        throw new Error(
          `the next tokenId is now #${next}, the manifest was built for #${tokenId}: rebuild and re-upload the manifest, then mint again`,
        );
      }
      const built = buildManifest(fullDraft(prepared.contentHash), tokenId);
      const result = await mintToken(wallet, publicClient, config.deployment, {
        policyHash: built.policyHash,
        assetId: built.assetId,
        contentHash: prepared.contentHash,
        manifestURI,
      });
      setMinted(result);
      if (
        result.tokenId !== undefined &&
        result.tokenId.toString() !== tokenId
      ) {
        throw new Error(
          `minted token #${result.tokenId.toString()} but the manifest names #${tokenId}: this asset's manifest binding is broken - do not publish it`,
        );
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  }, [
    config.deployment,
    fullDraft,
    manifestURI,
    prepared,
    publicClient,
    simulateNextTokenId,
    tokenId,
    wallet,
  ]);

  const field = (label: string, input: React.ReactNode) => (
    <div className="block text-sm space-y-1">
      <span>{label}</span>
      {input}
    </div>
  );

  return (
    <div className="space-y-4">
      <h2>Creator console</h2>
      <section className="card space-y-3">
        <h3>1. Encrypt the dataset in your browser</h3>
        <input
          type="file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void onFile(file);
          }}
        />
        {prepared !== undefined && (
          <p className="text-sm mono">
            {prepared.blob.length} bytes encrypted · contentHash{" "}
            {prepared.contentHash}
          </p>
        )}
      </section>
      <section className="card grid gap-3 md:grid-cols-2">
        <h3 className="md:col-span-2">2. Rights policy</h3>
        {field(
          "name (assetId seed)",
          <input
            className="field"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />,
        )}
        {field(
          "price (HBAR)",
          <input
            className="field"
            value={draft.priceHbar}
            onChange={(e) => setDraft({ ...draft, priceHbar: e.target.value })}
          />,
        )}
        {field(
          "duration (s)",
          <input
            className="field"
            type="number"
            value={draft.durationSec}
            onChange={(e) =>
              setDraft({ ...draft, durationSec: Number(e.target.value) })
            }
          />,
        )}
        {field(
          "max uses",
          <input
            className="field"
            type="number"
            value={draft.maxUses}
            onChange={(e) =>
              setDraft({ ...draft, maxUses: Number(e.target.value) })
            }
          />,
        )}
        {field(
          "creator share (bps)",
          <input
            className="field"
            type="number"
            value={draft.creatorBps}
            onChange={(e) =>
              setDraft({ ...draft, creatorBps: Number(e.target.value) })
            }
          />,
        )}
        {field(
          "transfer mode",
          <select
            className="field"
            value={draft.transferMode}
            onChange={(e) =>
              setDraft({
                ...draft,
                transferMode: e.target.value as ManifestDraft["transferMode"],
              })
            }
          >
            <option value="SURVIVE_TRANSFER">SURVIVE_TRANSFER</option>
            <option value="INVALIDATE_ON_TRANSFER">
              INVALIDATE_ON_TRANSFER
            </option>
          </select>,
        )}
        <div className="md:col-span-2 flex gap-4 text-sm">
          {(
            ["commercialUse", "aiTraining", "derivativeGeneration"] as const
          ).map((perm) => (
            <label key={perm} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={draft.permissions[perm]}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    permissions: {
                      ...draft.permissions,
                      [perm]: e.target.checked,
                    },
                  })
                }
              />
              {perm}
            </label>
          ))}
        </div>
        {field(
          "preview URI (public)",
          <input
            className="field"
            value={draft.previewURI}
            onChange={(e) => setDraft({ ...draft, previewURI: e.target.value })}
          />,
        )}
        {field(
          "encrypted content URI (ipfs://…, after upload)",
          <input
            className="field"
            value={draft.encryptedContentURI}
            onChange={(e) =>
              setDraft({ ...draft, encryptedContentURI: e.target.value })
            }
          />,
        )}
      </section>
      <section className="card space-y-3">
        <h3>3. Manifest & shares</h3>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => void predictTokenId()}
            disabled={prepared === undefined || busy !== undefined}
          >
            Predict tokenId
          </button>
          {tokenId !== undefined && (
            <span className="tag accent">next tokenId #{tokenId}</span>
          )}
          <button
            type="button"
            className="btn"
            onClick={artifacts}
            disabled={prepared === undefined || tokenId === undefined}
          >
            Download content.enc + manifest.json + shares.json
          </button>
        </div>
        <p className="text-sm">
          Upload content.enc and manifest.json to IPFS, hand shares.json to the
          gateway operator (scripts/load-shares.ts), then paste the manifest URI
          below.
        </p>
      </section>
      <section className="card space-y-3">
        <h3>4. Mint</h3>
        {field(
          "manifest URI (ipfs://…)",
          <input
            className="field"
            value={manifestURI}
            onChange={(e) => setManifestURI(e.target.value)}
          />,
        )}
        <button
          type="button"
          className="btn primary"
          onClick={() => void mint()}
          disabled={
            prepared === undefined ||
            tokenId === undefined ||
            manifestURI === "" ||
            busy !== undefined
          }
        >
          Mint RightsNFT
        </button>
        {minted !== undefined && (
          <p className="text-sm mono">
            minted token #{minted.tokenId?.toString() ?? "?"} ·{" "}
            <a
              href={`https://hashscan.io/testnet/transaction/${minted.txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              {minted.txHash}
            </a>
          </p>
        )}
      </section>
      {busy !== undefined && <p className="text-sm">{busy}</p>}
      {error !== undefined && <ErrorNote error={error} />}
    </div>
  );
}
