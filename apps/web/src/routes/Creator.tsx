import { usePrivy } from "@privy-io/react-auth";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { uploadCreatorFile } from "../creator/upload";
import { downloadBytes } from "../lib/download";

/**
 * Creator console (tasks.md T110): encrypt in the browser -> split K -> predict the tokenId ->
 * build + validate the Rights Manifest -> signed Pinata SDK upload -> mint.
 * The shares never touch the gateway from here: they go to the operator's load-shares script.
 */
type Prepared = {
  blob: Uint8Array;
  contentHash: Hex;
  shares: { shareG: Uint8Array; shareU: Uint8Array };
};

export default function Creator() {
  const { config, api } = useGateway();
  const { getAccessToken } = usePrivy();
  const operation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const wallet = useEmbeddedWallet();
  const publicClient = usePublicClient();
  const [prepared, setPrepared] = useState<Prepared | undefined>();
  const [draft, setDraftState] = useState<
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
  const [selectedFile, setSelectedFile] = useState<
    { name: string; size: number } | undefined
  >();
  const [encrypting, setEncrypting] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const setDraft = (value: typeof draft) => {
    setDraftState(value);
    setManifestURI("");
  };
  const isLocked = busy !== undefined || encrypting;

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
    if (operation.current) return;
    operation.current = true;
    setManifestURI("");
    setTokenId(undefined);
    setDraftState((current) => ({ ...current, encryptedContentURI: "" }));
    setError(undefined);
    setSelectedFile({ name: file.name, size: file.size });
    setPrepared(undefined);
    setEncrypting(true);
    try {
      const { key, blob } = await encryptDataset(
        new Uint8Array(await file.arrayBuffer()),
      );
      const shares = splitKey(key);
      key.fill(0);
      if (!mounted.current) {
        shares.shareG.fill(0);
        shares.shareU.fill(0);
        return;
      }
      setPrepared({ blob, contentHash: contentHashOf(blob), shares });
    } catch (e) {
      setError(e);
    } finally {
      operation.current = false;
      setEncrypting(false);
    }
  }, []);

  const simulateNextTokenId = useCallback(async (): Promise<string> => {
    if (prepared === undefined || wallet.address === undefined) {
      throw new Error("encrypt a dataset and connect a wallet first");
    }
    // Mint simulation needs the policy and asset hashes; the placeholder token ID is not published.
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
    if (operation.current) return;
    operation.current = true;
    setManifestURI("");
    setBusy("simulating mint to learn the next tokenId…");
    try {
      const next = await simulateNextTokenId();
      if (mounted.current) setTokenId(next);
    } catch (e) {
      setError(e);
    } finally {
      operation.current = false;
      setBusy(undefined);
    }
  }, [simulateNextTokenId]);

  const artifacts = useCallback(
    (kind: "manifest" | "shares") => {
      if (prepared === undefined || tokenId === undefined) return;
      try {
        const built = buildManifest(fullDraft(prepared.contentHash), tokenId);
        if (kind === "manifest")
          downloadBytes(
            "manifest.json",
            JSON.stringify(built.manifest, null, 2),
            "application/json",
          );
        if (kind === "shares")
          downloadBytes(
            "shares.json",
            sharesArtifact({ assetId: built.assetId, ...prepared.shares }),
            "application/json",
          );
      } catch (e) {
        setError(e);
      }
    },
    [fullDraft, prepared, tokenId],
  );

  const mint = useCallback(async () => {
    if (prepared === undefined || tokenId === undefined) return;
    setError(undefined);
    if (operation.current) return;
    operation.current = true;
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
      operation.current = false;
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

  const upload = async (
    purpose: "preview" | "encrypted-content" | "manifest",
    preview?: File,
  ) => {
    if (operation.current) return;
    operation.current = true;
    setError(undefined);
    setBusy(`Uploading ${purpose} to IPFS…`);
    setManifestURI("");
    try {
      let file: File;
      let predicted: string | undefined;
      if (purpose === "preview") {
        if (!preview) return;
        file = preview;
      } else {
        if (!prepared) throw new Error("Encrypt a dataset first");
        if (purpose === "encrypted-content") {
          file = new File([prepared.blob.slice()], "content.enc", {
            type: "application/octet-stream",
          });
        } else {
          predicted = await simulateNextTokenId();
          const built = buildManifest(
            fullDraft(prepared.contentHash),
            predicted,
          );
          file = new File(
            [JSON.stringify(built.manifest, null, 2)],
            "manifest.json",
            { type: "application/json" },
          );
        }
      }
      const uri = await uploadCreatorFile(api, getAccessToken, purpose, file);
      if (!mounted.current) return;
      if (purpose === "manifest") {
        setTokenId(predicted);
        setManifestURI(uri);
      } else {
        setDraftState((current) => ({
          ...current,
          [purpose === "preview" ? "previewURI" : "encryptedContentURI"]: uri,
        }));
      }
    } catch (e) {
      setError(e);
    } finally {
      operation.current = false;
      setBusy(undefined);
    }
  };

  const field = (label: string, input: React.ReactNode) => (
    <div className="block text-sm space-y-1">
      <span>{label}</span>
      {input}
    </div>
  );

  return (
    <div className="space-y-4">
      <h2>Creator console</h2>
      <fieldset disabled={isLocked} className="contents">
        <section className="card space-y-3">
          <h3>1. Encrypt the dataset in your browser</h3>
          <p className="creator-upload-intro">
            Your file is encrypted locally before anything leaves this device.
          </p>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is a visual
            enhancement layer only - the actual keyboard/screen-reader-accessible control is
            the <label htmlFor="creator-dataset">/<input type="file"> pair rendered inside it. */}
          <div
            className={`creator-upload${dragActive ? " is-dragging" : ""}${
              prepared !== undefined ? " is-ready" : ""
            }`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setDragActive(false);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragActive(false);
              const file = event.dataTransfer.files[0];
              if (file !== undefined) void onFile(file);
            }}
          >
            <div className="creator-upload-icon" aria-hidden="true">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
                <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
              </svg>
            </div>
            <div className="creator-upload-copy">
              <strong>
                {dragActive
                  ? "Drop your dataset here"
                  : (selectedFile?.name ?? "Choose a dataset to encrypt")}
              </strong>
              <span>
                {selectedFile === undefined
                  ? "Drag and drop a JSON, CSV, or data file"
                  : `${(selectedFile.size / 1024).toLocaleString(undefined, {
                      maximumFractionDigits: 1,
                    })} KB · ${
                      encrypting
                        ? "Encrypting in your browser…"
                        : prepared === undefined
                          ? "Encryption failed — choose another file"
                          : "Encrypted and ready"
                    }`}
              </span>
            </div>
            <label className="creator-upload-button" htmlFor="creator-dataset">
              {selectedFile === undefined ? "Choose file" : "Replace file"}
            </label>
            <input
              id="creator-dataset"
              className="creator-file-input"
              type="file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void onFile(file);
                event.target.value = "";
              }}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn"
              disabled={!prepared}
              onClick={() => void upload("encrypted-content")}
            >
              Upload encrypted content to IPFS
            </button>
            <button
              type="button"
              className="btn"
              disabled={!prepared}
              onClick={() =>
                prepared && downloadBytes("content.enc", prepared.blob)
              }
            >
              Download content.enc
            </button>
          </div>
          {prepared !== undefined && (
            <div className="creator-upload-result">
              <span className="creator-upload-check" aria-hidden="true">
                ✓
              </span>
              <div>
                <strong>
                  {prepared.blob.length.toLocaleString()} bytes encrypted
                </strong>
                <code>{prepared.contentHash}</code>
              </div>
            </div>
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
              onChange={(e) =>
                setDraft({ ...draft, priceHbar: e.target.value })
              }
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
          <label className="block text-sm">
            Upload public preview (PNG, JPEG, WebP, or JSON; max 10 MiB)
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void upload("preview", file);
              }}
            />
          </label>
          {field(
            "preview URI (public; manual fallback)",
            <input
              className="field"
              value={draft.previewURI}
              onChange={(e) =>
                setDraft({ ...draft, previewURI: e.target.value })
              }
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
              onClick={() => artifacts("manifest")}
              disabled={
                !prepared ||
                tokenId === undefined ||
                !draft.encryptedContentURI ||
                !draft.previewURI
              }
            >
              Download manifest.json
            </button>
            <button
              type="button"
              className="btn"
              disabled={
                !prepared || !draft.encryptedContentURI || !draft.previewURI
              }
              onClick={() => void upload("manifest")}
            >
              Build & upload manifest to IPFS
            </button>
            <button
              type="button"
              className="btn"
              disabled={
                !prepared ||
                tokenId === undefined ||
                !draft.encryptedContentURI ||
                !draft.previewURI
              }
              onClick={() => artifacts("shares")}
            >
              Download private shares.json
            </button>
          </div>
          <p className="text-sm">
            Uploads are public: only the encrypted content, public preview and
            manifest are sent to IPFS. Keep shares.json private and hand it to
            the gateway operator (scripts/load-shares.ts). You can also upload
            the downloaded artifacts yourself and paste their IPFS URIs.
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
      </fieldset>
      {busy !== undefined && <p className="text-sm">{busy}</p>}
      {error !== undefined && <ErrorNote error={error} />}
    </div>
  );
}
