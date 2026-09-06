import { useCallback, useEffect, useMemo, useState } from "react";
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
 * All screen state belongs to one "session": a fresh object per (asset, path, receipt, wallet)
 * tuple, memoised for the render that created it, so A -> B -> A yields a third object and
 * cannot resurrect A's first results. Handlers are bound to the session they were rendered
 * with and commit only into that session's screen; rendering reads state only when it was
 * produced for the session on screen, so nothing from a previous asset is ever shown - not
 * even for one frame. No ref is mutated during render.
 */
type Unlocked =
  | { path: "owner"; dataset: Dataset; accessEpochAtGrant: number }
  | { path: "licensee"; dataset: Dataset; useIndex: number; onchainTx: string };

type Session = { tuple: string };

type Screen = {
  session: Session;
  asset?: AssetSummary;
  ownership?: Ownership;
  lanes: EpochLaneEvent[];
  unlocked?: Unlocked;
  busy?: string;
  error?: unknown;
};

function emptyScreen(session: Session): Screen {
  return { session, lanes: [] };
}

export default function Viewer() {
  const { assetId = "" } = useParams();
  const [search] = useSearchParams();
  const path = search.get("path") === "licensee" ? "licensee" : "owner";
  const receiptHash = search.get("receipt") ?? undefined;
  const { config, api } = useGateway();
  const wallet = useEmbeddedWallet();
  const signers = useSigners(wallet);
  const publicClient = usePublicClient();

  const tuple = `${assetId.toLowerCase()}|${path}|${receiptHash ?? ""}|${wallet.address ?? ""}`;
  // a new object whenever the tuple changes (identity is the session; no mutation in render)
  const session = useMemo<Session>(() => ({ tuple }), [tuple]);

  const [screen, setScreen] = useState<Screen>(() => emptyScreen(session));
  // state produced for another session is never rendered
  const view = screen.session === session ? screen : emptyScreen(session);

  /** commit a partial update only into the screen that belongs to `owner` */
  const commit = useCallback((owner: Session, patch: Partial<Screen>) => {
    setScreen((prev) =>
      prev.session === owner ? { ...prev, ...patch } : prev,
    );
  }, []);

  const refresh = useCallback(
    async (owner: Session) => {
      const found = (await listAssets(api)).find(
        (a) => a.assetId.toLowerCase() === assetId.toLowerCase(),
      );
      commit(owner, { asset: found });
      if (found === undefined) return;
      const tokenId = BigInt(found.tokenId);
      const ownership = await readOwnership(
        publicClient,
        config.deployment,
        tokenId,
      );
      commit(owner, { ownership });
      try {
        const timeline = await fetchTokenTimeline(api, found.tokenId);
        commit(owner, {
          lanes: timeline === undefined ? [] : toEpochLanes(timeline),
        });
      } catch {
        commit(owner, { lanes: [] }); // discovery only: the viewer works without the graph
      }
    },
    [api, assetId, commit, config.deployment, publicClient],
  );

  // every new session starts from an empty screen and its own refresh
  useEffect(() => {
    setScreen(emptyScreen(session));
    refresh(session).catch((e: unknown) => commit(session, { error: e }));
  }, [session, refresh, commit]);

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
    const owner = session; // bound to the session this handler was rendered for
    commit(owner, {
      error: undefined,
      unlocked: undefined,
      busy:
        path === "owner"
          ? "owner challenge → signature → share_G…"
          : "licensee challenge → signature → consume → share_G…",
    });
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
      commit(owner, { unlocked: next });
    } catch (e) {
      commit(owner, { error: e });
    } finally {
      commit(owner, { busy: undefined });
      refresh(owner).catch(() => undefined);
    }
  }, [assetId, commit, deps, path, receiptHash, refresh, session]);

  const [transferTo, setTransferTo] = useState("");
  const transfer = useCallback(async () => {
    const owner = session;
    const asset = view.asset;
    if (asset === undefined) return;
    commit(owner, {
      error: undefined,
      busy: "safeTransferFrom → waiting for the receipt…",
    });
    try {
      const hash = await transferToken(
        wallet,
        config.deployment,
        transferTo as Address,
        BigInt(asset.tokenId),
      );
      await publicClient.waitForTransactionReceipt({ hash });
      commit(owner, { unlocked: undefined });
      await refresh(owner);
    } catch (e) {
      commit(owner, { error: e });
    } finally {
      commit(owner, { busy: undefined });
    }
  }, [
    commit,
    config.deployment,
    publicClient,
    refresh,
    session,
    transferTo,
    view.asset,
    wallet,
  ]);

  // "licensee" is only claimed once a consume actually succeeded in this session; the URL
  // alone proves nothing. Owner / creator come from the pinned chain read.
  const { asset, ownership, unlocked, busy, error, lanes } = view;
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
