import { useCallback, useEffect, useState } from "react";
import type { Hex } from "viem";
import { type AuditEntry, listAudit } from "../api/client";
import { useGateway } from "../app/gateway";
import { runConcurrentReplay } from "../attacks/concurrentReplay";
import { useEmbeddedWallet, useSigners } from "../chain/hooks";
import AttackCounter from "../components/AttackCounter";
import EpochTimeline from "../components/EpochTimeline";
import ErrorNote from "../components/ErrorNote";
import { formatHbar } from "../components/formatHbar";
import SplitScreen from "../components/SplitScreen";
import {
  fetchTokenTimeline,
  short,
  type TokenTimeline,
  toEpochLanes,
} from "../graph/queries";

const PARALLELISM = 20;

/**
 * Dashboard (tasks.md T113): Rights Graph audit view (transfers / receipts / allocations),
 * the live concurrent-replay counter and the gateway's deny log (GET /audit).
 */
export default function Dashboard() {
  const { api } = useGateway();
  const wallet = useEmbeddedWallet();
  const signers = useSigners(wallet);
  const [tokenId, setTokenId] = useState("1");
  const [timeline, setTimeline] = useState<TokenTimeline | undefined>();
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [attack, setAttack] = useState({ assetId: "", receiptHash: "" });
  const [error, setError] = useState<unknown>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const [tl, entries] = await Promise.all([
        fetchTokenTimeline(api, tokenId),
        listAudit(api, { limit: 50 }),
      ]);
      setTimeline(tl);
      setAudit(entries);
    } catch (e) {
      setError(e);
    }
  }, [api, tokenId]);

  useEffect(() => {
    void load();
  }, [load]);

  const hexOk = (v: string) => /^0x[0-9a-fA-F]{64}$/.test(v);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2>Rights Graph</h2>
        <input
          className="field mono max-w-32"
          value={tokenId}
          onChange={(e) => setTokenId(e.target.value)}
          aria-label="tokenId"
        />
        <button type="button" className="btn" onClick={() => void load()}>
          reload
        </button>
      </div>
      {error !== undefined && <ErrorNote error={error} />}
      {timeline === undefined ? (
        <p className="card">token #{tokenId} is not indexed (yet)</p>
      ) : (
        <>
          <EpochTimeline events={toEpochLanes(timeline)} />
          <SplitScreen
            left={{
              title: "Receipts (indexed)",
              body: (
                <>
                  {timeline.receipts.length === 0 && (
                    <p className="text-sm">none issued</p>
                  )}
                  {timeline.receipts.map((r) => (
                    <div key={r.id} className="text-sm mono">
                      {short(r.id)} · {short(r.licensee)} · {r.usedCount}/
                      {r.maxUses} uses ·{" "}
                      <span
                        className={`tag ${r.transferMode === 0 ? "ok" : "warn"}`}
                      >
                        {r.transferMode === 0 ? "SURVIVE" : "INVALIDATE"}
                      </span>
                    </div>
                  ))}
                </>
              ),
            }}
            right={{
              title: "Revenue allocations (indexed)",
              body: (
                <>
                  {timeline.allocations.length === 0 && (
                    <p className="text-sm">none yet</p>
                  )}
                  {timeline.allocations.map((a) => (
                    <div key={a.id} className="text-sm mono">
                      block {a.blockNumber}: owner {short(a.owner)}{" "}
                      {formatHbar(BigInt(a.ownerAmount))} · creator{" "}
                      {formatHbar(BigInt(a.creatorAmount))}
                    </div>
                  ))}
                </>
              ),
            }}
          />
        </>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <input
            className="field mono"
            placeholder="assetId 0x…"
            value={attack.assetId}
            onChange={(e) => setAttack({ ...attack, assetId: e.target.value })}
          />
          <input
            className="field mono"
            placeholder="receiptHash 0x…"
            value={attack.receiptHash}
            onChange={(e) =>
              setAttack({ ...attack, receiptHash: e.target.value })
            }
          />
        </div>
        <AttackCounter
          parallelism={PARALLELISM}
          run={async () => {
            if (wallet.address === undefined)
              throw new Error("connect a wallet");
            if (!hexOk(attack.assetId) || !hexOk(attack.receiptHash)) {
              throw new Error("assetId and receiptHash must be 32-byte hex");
            }
            return runConcurrentReplay({
              api,
              signers,
              wallet: wallet.address,
              assetId: attack.assetId as Hex,
              receiptHash: attack.receiptHash as Hex,
              parallelism: PARALLELISM,
            });
          }}
        />
      </section>

      <section className="card space-y-1">
        <div className="flex items-center justify-between">
          <h3>Gateway audit log</h3>
          <span className="tag warn">GET /audit (allow + deny)</span>
        </div>
        {audit.length === 0 && <p className="text-sm">no entries</p>}
        {audit.map((entry) => (
          <div key={entry.id} className="text-sm mono flex flex-wrap gap-2">
            <span>{new Date(entry.at * 1000).toISOString()}</span>
            <span>{entry.action}</span>
            <span
              className={`tag ${entry.outcome === "allow" ? "ok" : "deny"}`}
            >
              {entry.outcome}
              {entry.code !== undefined ? ` ${entry.code}` : ""}
            </span>
            {entry.subject !== undefined && <span>{short(entry.subject)}</span>}
          </div>
        ))}
      </section>
    </div>
  );
}
