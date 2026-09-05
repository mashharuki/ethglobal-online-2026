import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { type AssetSummary, listAssets } from "../api/client";
import { useGateway } from "../app/gateway";
import { useEmbeddedWallet, useSigners } from "../chain/hooks";
import ErrorNote from "../components/ErrorNote";
import PricePanel from "../components/PricePanel";
import { short } from "../graph/queries";
import { activateHollowAccount } from "../hedera/activateAccount";
import { resolveHederaAccount } from "../hedera/resolveAccount";
import { buyAccess } from "../x402/buy";
import {
  createPrivyHederaSigner,
  recoverWalletPublicKey,
} from "../x402/privyHederaSigner";

/**
 * Market (tasks.md T111): the Rights Graph listing, preview, "Access as owner" and the x402
 * purchase (native HBAR through the Privy embedded wallet).
 */
export default function Market() {
  const { config, api } = useGateway();
  const wallet = useEmbeddedWallet();
  const signers = useSigners(wallet);
  const navigate = useNavigate();
  const [assets, setAssets] = useState<AssetSummary[] | undefined>();
  const [error, setError] = useState<unknown>();
  const [buying, setBuying] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();

  useEffect(() => {
    listAssets(api).then(setAssets, setError);
  }, [api]);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2>Market</h2>
        <span className="tag warn">listing indexed by the Rights Graph</span>
      </div>
      {error !== undefined && <ErrorNote error={error} />}
      {note !== undefined && <p className="text-sm">{note}</p>}
      {assets === undefined && error === undefined && <p>loading assets…</p>}
      {assets?.length === 0 && <p className="card">no assets published yet</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {assets?.map((asset) => (
          <section key={asset.assetId} className="card space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 title={asset.assetId}>asset {short(asset.assetId)}</h3>
                <div className="text-sm">
                  token #{asset.tokenId} · owner{" "}
                  <code title={asset.owner}>{short(asset.owner ?? "?")}</code>
                </div>
              </div>
              <a
                className="btn"
                href={`${config.gatewayUrl}/assets/${asset.assetId}/preview`}
                target="_blank"
                rel="noreferrer"
              >
                preview
              </a>
            </div>
            <PricePanel
              asset={asset}
              onBuy={() => void buy(asset)}
              buying={buying === asset.assetId}
              disabledReason={
                wallet.address === undefined
                  ? "connect a wallet first"
                  : undefined
              }
            />
            <button
              type="button"
              className="btn"
              onClick={() => navigate(`/viewer/${asset.assetId}?path=owner`)}
            >
              Access as owner (free)
            </button>
          </section>
        ))}
      </div>
    </div>
  );
}
