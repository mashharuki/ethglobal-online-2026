import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { type AssetSummary, listAssets } from "../api/client";
import { useGateway } from "../app/gateway";
import {
  readOwnership,
  useEmbeddedWallet,
  usePublicClient,
  useSigners,
} from "../chain/hooks";
import AssetCard from "../components/AssetCard";
import ErrorNote from "../components/ErrorNote";
import { activateHollowAccount } from "../hedera/activateAccount";
import { resolveHederaAccount } from "../hedera/resolveAccount";
import { buyAccess } from "../x402/buy";
import {
  createPrivyHederaSigner,
  recoverWalletPublicKey,
} from "../x402/privyHederaSigner";

type PermissionFilter =
  | "all"
  | "commercialUse"
  | "aiTraining"
  | "derivativeGeneration";

const PERMISSION_FILTERS: Array<{ key: PermissionFilter; label: string }> = [
  { key: "all", label: "All assets" },
  { key: "commercialUse", label: "Commercial use" },
  { key: "aiTraining", label: "AI training" },
  { key: "derivativeGeneration", label: "Derivatives" },
];

type SortMode = "featured" | "low" | "high";

type AssetPreview = { title?: string; description?: string };

/** The preview JSON is free-form (not part of the validated Rights Manifest schema) - read the
 * two fields the card can use and ignore everything else, defensively. */
function parsePreview(value: unknown): AssetPreview {
  if (value === null || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    title: typeof record.title === "string" ? record.title : undefined,
    description:
      typeof record.description === "string" ? record.description : undefined,
  };
}

/**
 * Market (tasks.md T111): the Rights Graph listing, preview, "Access as owner" and the x402
 * purchase (native HBAR through the Privy embedded wallet). Redesigned 2026-09 ("premium
 * marketplace" direction, apps/web/DESIGN.md) - search/filter/sort are purely client-side over
 * already-fetched assets; permission filters use the real Rights Manifest booleans, not invented
 * categories, since AssetSummary has no free-text tagging.
 */
export default function Market() {
  const { config, api } = useGateway();
  const wallet = useEmbeddedWallet();
  const signers = useSigners(wallet);
  const publicClient = usePublicClient();
  const navigate = useNavigate();
  const [assets, setAssets] = useState<AssetSummary[] | undefined>();
  const [currentOwners, setCurrentOwners] = useState<Record<string, string>>(
    {},
  );
  const [previews, setPreviews] = useState<Record<string, AssetPreview>>({});
  const [error, setError] = useState<unknown>();
  const [buying, setBuying] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<PermissionFilter>("all");
  const [sort, setSort] = useState<SortMode>("featured");

  useEffect(() => {
    listAssets(api).then(setAssets, setError);
  }, [api]);

  // The listing is indexed, but owner-only UI follows fresh Hedera reads. Until a live owner
  // has been resolved, the free owner action stays hidden instead of trusting indexed data.
  useEffect(() => {
    if (assets === undefined) return;
    let active = true;
    Promise.all(
      assets.map(async (asset) => {
        const ownership = await readOwnership(
          publicClient,
          config.deployment,
          BigInt(asset.tokenId),
        );
        return [
          asset.assetId.toLowerCase(),
          ownership.owner.toLowerCase(),
        ] as const;
      }),
    )
      .then((entries) => {
        if (active) setCurrentOwners(Object.fromEntries(entries));
      })
      .catch(() => {
        if (active) setCurrentOwners({});
      });
    return () => {
      active = false;
    };
  }, [assets, config.deployment, publicClient]);

  // Best-effort: the card's title/description come from the same preview JSON the "Preview"
  // link already points at (IPFS via the gateway's redirect); a slow/unreachable gateway just
  // falls back to AssetCard's own "asset {hash}" heading, it never blocks the listing.
  useEffect(() => {
    if (assets === undefined) return;
    let active = true;
    Promise.all(
      assets.map(async (asset) => {
        try {
          const res = await fetch(
            `${config.gatewayUrl}/assets/${asset.assetId}/preview`,
          );
          if (!res.ok) return [asset.assetId.toLowerCase(), {}] as const;
          return [
            asset.assetId.toLowerCase(),
            parsePreview(await res.json()),
          ] as const;
        } catch {
          return [asset.assetId.toLowerCase(), {}] as const;
        }
      }),
    ).then((entries) => {
      if (active) setPreviews(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [assets, config.gatewayUrl]);

  const buy = useCallback(
    async (asset: AssetSummary) => {
      if (wallet.address === undefined) return;
      const evmAddress = wallet.address;
      setBuying(asset.assetId);
      setError(undefined);
      try {
        setNote("resolving the Hedera account of the wallet…");
        const account = await resolveHederaAccount(
          evmAddress,
          config.mirrorNodeUrl,
        );
        if (account === null) {
          throw new Error(
            `no Hedera account for ${evmAddress} yet - fund it on Testnet first`,
          );
        }
        if (!account.hasKey) {
          setNote("activating the hollow account (one 1-tinybar transfer)…");
          const publicKey = await recoverWalletPublicKey(
            evmAddress,
            signers.signRawHash,
          );
          await activateHollowAccount(
            account.accountId,
            publicKey,
            signers.signRawHash,
          );
        }
        setNote("quote → signed HBAR transfer → settlement…");
        const signer = createPrivyHederaSigner({
          accountId: account.accountId,
          evmAddress,
          signRawHash: signers.signRawHash,
        });
        const result = await buyAccess({
          api,
          signer,
          licensee: evmAddress,
          assetId: asset.assetId as `0x${string}`,
          balanceTinybars: account.balanceTinybars,
        });
        navigate(
          `/viewer/${asset.assetId}?path=licensee&receipt=${result.settled.receiptHash}`,
        );
      } catch (e) {
        setError(e);
      } finally {
        setBuying(undefined);
        setNote(undefined);
      }
    },
    [api, config.mirrorNodeUrl, navigate, signers, wallet.address],
  );

  const visible = useMemo(() => {
    if (assets === undefined) return undefined;
    const term = search.trim().toLowerCase();
    const filtered = assets.filter((asset) => {
      if (filter !== "all" && !asset.permissions[filter]) return false;
      if (term === "") return true;
      return (
        asset.assetId.toLowerCase().includes(term) ||
        asset.tokenId.includes(term) ||
        (asset.owner ?? "").toLowerCase().includes(term)
      );
    });
    if (sort === "featured") return filtered;
    const sorted = [...filtered].sort((a, b) => {
      const diff = BigInt(a.paidAccess.price) - BigInt(b.paidAccess.price);
      const cmp = diff < 0n ? -1 : diff > 0n ? 1 : 0;
      return sort === "low" ? cmp : -cmp;
    });
    return sorted;
  }, [assets, filter, search, sort]);

  return (
    <div className="space-y-4">
      <section className="market-hero">
        <div className="market-hero-copy">
          <div className="market-eyebrow">A new kind of ownership</div>
          <h1>
            Extraordinary data.
            <br />
            <span>Yours to access.</span>
          </h1>
          <p>
            Every listing is a RightsNFT: ownership and paid access are two
            independent on-chain epochs, so a sale never silently revokes what a
            buyer already paid for.
          </p>
          <div className="market-stats">
            <div>
              <div className="market-stat-num">{assets?.length ?? "–"}</div>
              <div className="market-stat-label">assets listed</div>
            </div>
          </div>
        </div>
        <div className="market-feature">
          <div className="market-feature-orb" />
          <div className="market-feature-caption">
            <small>OWNERSHIP, REIMAGINED</small>
            <h3>Encrypted at source. Unlocked by you.</h3>
            <p>Independent creators. Transparent, on-chain terms.</p>
          </div>
        </div>
      </section>

      {error !== undefined && <ErrorNote error={error} />}
      {note !== undefined && <p className="text-sm">{note}</p>}
      {assets === undefined && error === undefined && <p>loading assets…</p>}

      {assets !== undefined && assets.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2>The collection</h2>
            <span className="tag warn">
              listing indexed by the Rights Graph
            </span>
          </div>
          <div className="market-toolbar">
            <div className="market-filters">
              {PERMISSION_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`market-filter${filter === f.key ? " active" : ""}`}
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                className="field market-search"
                type="search"
                placeholder="Search the collection"
                aria-label="Search the collection"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                className="field"
                aria-label="Sort assets"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortMode)}
              >
                <option value="featured">Featured first</option>
                <option value="low">Price: low to high</option>
                <option value="high">Price: high to low</option>
              </select>
            </div>
          </div>
        </>
      )}

      {assets?.length === 0 && <p className="card">no assets published yet</p>}
      {assets !== undefined && assets.length > 0 && visible?.length === 0 && (
        <p className="card">no assets match this search/filter</p>
      )}

      <div className="asset-grid">
        {visible?.map((asset, index) => (
          <AssetCard
            key={asset.assetId}
            asset={asset}
            index={index}
            previewHref={`${config.gatewayUrl}/assets/${asset.assetId}/preview`}
            preview={previews[asset.assetId.toLowerCase()]}
            onBuy={() => void buy(asset)}
            buying={buying === asset.assetId}
            buyDisabledReason={
              wallet.address === undefined
                ? "connect a wallet first"
                : undefined
            }
            onAccessAsOwner={() =>
              navigate(`/viewer/${asset.assetId}?path=owner`)
            }
            isOwner={
              wallet.address !== undefined &&
              currentOwners[asset.assetId.toLowerCase()] ===
                wallet.address.toLowerCase()
            }
          />
        ))}
      </div>

      {assets !== undefined && assets.length > 0 && (
        <div className="market-trust">
          <span>Encrypted in your browser</span>
          <span>On-chain access receipts</span>
          <span>Ownership and access, independent</span>
        </div>
      )}
    </div>
  );
}
