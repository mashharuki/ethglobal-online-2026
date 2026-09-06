import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import type { Address, Hex } from "viem";
import { type AssetSummary, listAssets } from "../api/client";
import { useGateway } from "../app/gateway";
import {
  type Ownership,
  readOwnership,
  transferToken,
  useEmbeddedWallet,
  usePublicClient,
  useSigners,
} from "../chain/hooks";
import DatasetView from "../components/DatasetView";
import EpochTimeline from "../components/EpochTimeline";
import ErrorNote from "../components/ErrorNote";
import RightsBadge, { type RightsRole } from "../components/RightsBadge";
import {
  type AccessDeps,
  accessAsLicensee,
  accessAsOwner,
} from "../flows/access";
import {
  type EpochLaneEvent,
  fetchTokenTimeline,
  toEpochLanes,
} from "../graph/queries";
import type { Dataset } from "../keygate/decrypt";

/**
 * Viewer (tasks.md T112): owner path (challenge -> sign -> /owner/keygate -> decrypt) and
 * licensee path (/keygate/share -> useIndex -> decrypt), the RightsBadge from a fresh chain
 * read, the EpochTimeline from the Rights Graph, and a transfer form for the demo.
 *
 * Every async result is tagged with the "session" it belongs to (asset + path + receipt +
 * wallet); results from a previous session are discarded so a stale read or decrypt can never
 * populate the screen of another asset.
 */
type Unlocked =
  | { path: "owner"; dataset: Dataset; accessEpochAtGrant: number }
  | { path: "licensee"; dataset: Dataset; useIndex: number; onchainTx: string };

export default function Viewer() {
  const { assetId = "" } = useParams();
  const [search] = useSearchParams();
  const path = search.get("path") === "licensee" ? "licensee" : "owner";
  const receiptHash = search.get("receipt") ?? undefined;
  const { config, api } = useGateway();
  const wallet = useEmbeddedWallet();
  const signers = useSigners(wallet);
  const publicClient = usePublicClient();

  const sessionKey = `${assetId.toLowerCase()}|${path}|${receiptHash ?? ""}|${wallet.address ?? ""}`;
  const session = useRef(sessionKey);
  session.current = sessionKey;
  const isCurrent = useCallback((key: string) => session.current === key, []);

  const [asset, setAsset] = useState<AssetSummary | undefined>();
  const [ownership, setOwnership] = useState<Ownership | undefined>();
  const [lanes, setLanes] = useState<EpochLaneEvent[]>([]);
  const [unlocked, setUnlocked] = useState<Unlocked | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<unknown>();
  const [transferTo, setTransferTo] = useState("");

  const refresh = useCallback(async () => {
    const key = session.current;
    const found = (await listAssets(api)).find(
      (a) => a.assetId.toLowerCase() === assetId.toLowerCase(),
    );
    if (!isCurrent(key)) return;
    setAsset(found);
    if (found === undefined) return;
    const tokenId = BigInt(found.tokenId);
    const state = await readOwnership(publicClient, config.deployment, tokenId);
    if (!isCurrent(key)) return;
    setOwnership(state);
    try {
      const timeline = await fetchTokenTimeline(api, found.tokenId);
      if (!isCurrent(key)) return;
      setLanes(timeline === undefined ? [] : toEpochLanes(timeline));
    } catch {
      if (isCurrent(key)) setLanes([]); // discovery only: the viewer works without the graph
    }
  }, [api, assetId, config.deployment, isCurrent, publicClient]);

  // a new asset / path / receipt / wallet is a new session: nothing from before survives
  useEffect(() => {
    setAsset(undefined);
    setOwnership(undefined);
    setLanes([]);
    setUnlocked(undefined);
    setError(undefined);
    setBusy(undefined);
    refresh().catch((e: unknown) => {
      if (isCurrent(sessionKey)) setError(e);
    });
  }, [sessionKey, refresh, isCurrent]);

  const deps = useMemo<AccessDeps | undefined>(
    () =>
      wallet.address === undefined
        ? undefined
        : {
            api,
            signers,
            wallet: wallet.address,
            deployment: config.deployment,
            ipfsGateway: config.ipfsGatewayUrl,
          },
    [api, signers, wallet.address, config.deployment, config.ipfsGatewayUrl],
  );

  const unlock = useCallback(async () => {
    if (deps === undefined) return;
    const key = session.current;
    setError(undefined);
    setUnlocked(undefined);
    setBusy(
      path === "owner"
        ? "owner challenge → signature → share_G…"
        : "licensee challenge → signature → consume → share_G…",
    );
    try {
      let next: Unlocked;
      if (path === "owner") {
        const { release, dataset } = await accessAsOwner(deps, assetId as Hex);
        next = {
          path: "owner",
          dataset,
          accessEpochAtGrant: release.accessEpochAtGrant,
        };
      } else {
        if (receiptHash === undefined) throw new Error("no receipt in the URL");
        const { release, dataset } = await accessAsLicensee(
          deps,
          assetId as Hex,
          receiptHash as Hex,
        );
        next = {
          path: "licensee",
          dataset,
          useIndex: release.useIndex,
          onchainTx: release.onchainTx,
        };
      }
      if (isCurrent(key)) setUnlocked(next);
    } catch (e) {
      if (isCurrent(key)) setError(e);
    } finally {
      if (isCurrent(key)) {
        setBusy(undefined);
        refresh().catch(() => undefined);
      }
    }
  }, [assetId, deps, isCurrent, path, receiptHash, refresh]);

  const transfer = useCallback(async () => {
    if (asset === undefined) return;
    const key = session.current;
    setError(undefined);
    setBusy("safeTransferFrom → waiting for the receipt…");
    try {
      const hash = await transferToken(
        wallet,
        config.deployment,
        transferTo as Address,
        BigInt(asset.tokenId),
      );
      await publicClient.waitForTransactionReceipt({ hash });
      if (!isCurrent(key)) return;
      setUnlocked(undefined);
      await refresh();
    } catch (e) {
      if (isCurrent(key)) setError(e);
    } finally {
      if (isCurrent(key)) setBusy(undefined);
    }
  }, [
    asset,
    config.deployment,
    isCurrent,
    publicClient,
    refresh,
    transferTo,
    wallet,
  ]);

  // "licensee" is only claimed once a consume actually succeeded for this session; the URL
  // alone proves nothing. Owner / creator come from the pinned chain read.
  const role: RightsRole =
    ownership === undefined || wallet.address === undefined
      ? "none"
      : ownership.owner.toLowerCase() === wallet.address.toLowerCase()
        ? "owner"
        : unlocked?.path === "licensee"
          ? "licensee"
          : ownership.creator.toLowerCase() === wallet.address.toLowerCase()
            ? "creator"
            : "none";

  if (asset === undefined) {
    return error === undefined ? (
      <p>loading asset…</p>
    ) : (
      <ErrorNote error={error} />
    );
  }
  return (
    <div className="space-y-4">
      <div className="card space-y-2">
        <h2 title={asset.assetId}>
          token #{asset.tokenId} · {path} path
        </h2>
        <RightsBadge
          role={role}
          accessEpoch={ownership?.accessEpoch}
          licenseEpoch={ownership?.licenseEpoch}
          readAtBlock={ownership?.block}
        />
        <div className="text-sm">
          owner <code title={ownership?.owner}>{ownership?.owner}</code>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn primary"
            onClick={() => void unlock()}
            disabled={busy !== undefined || deps === undefined}
          >
            {path === "owner" ? "Unlock as owner" : "Consume one use & unlock"}
          </button>
          {role === "owner" && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void transfer();
              }}
            >
              <input
                className="field mono"
                placeholder="transfer to 0x…"
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
              />
              <button
                type="submit"
                className="btn"
                disabled={
                  busy !== undefined || !/^0x[0-9a-fA-F]{40}$/.test(transferTo)
                }
              >
                Transfer NFT
              </button>
            </form>
          )}
        </div>
        {busy !== undefined && <p className="text-sm">{busy}</p>}
        {error !== undefined && <ErrorNote error={error} />}
      </div>
      {unlocked !== undefined && (
        <section className="card space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3>decrypted in the browser</h3>
            {unlocked.path === "owner" ? (
              <span className="tag ok">
                granted at owner epoch {unlocked.accessEpochAtGrant}
              </span>
            ) : (
              <>
                <span className="tag ok">
                  use #{unlocked.useIndex + 1} of {asset.paidAccess.maxUses}
                </span>
                <a
                  className="tag accent"
                  href={`https://hashscan.io/testnet/transaction/${unlocked.onchainTx}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  consume tx
                </a>
              </>
            )}
          </div>
          <DatasetView dataset={unlocked.dataset} />
        </section>
      )}
      <EpochTimeline events={lanes} />
    </div>
  );
}
