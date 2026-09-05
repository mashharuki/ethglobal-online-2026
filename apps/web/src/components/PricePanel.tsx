import type { AssetSummary } from "../api/client";
import { formatHbar } from "./formatHbar";

const WEIBAR_PER_TINYBAR = 10_000_000_000n;

/** Price / duration / uses / permissions straight from the Rights Manifest (FR-004). */
export default function PricePanel(props: {
  asset: AssetSummary;
  onBuy?: () => void;
  buying?: boolean;
  disabledReason?: string;
}) {
  const { paidAccess, permissions, transferMode } = props.asset;
  const tinybar = BigInt(paidAccess.price) / WEIBAR_PER_TINYBAR;
  const perms = [
    ["commercial use", permissions.commercialUse],
    ["AI training", permissions.aiTraining],
    ["derivatives", permissions.derivativeGeneration],
  ] as const;
  return (
    <div className="space-y-2">
      <div className="text-2xl" style={{ color: "var(--text-h)" }}>
        {formatHbar(tinybar)}
      </div>
      <div className="text-sm">
        {paidAccess.maxUses} uses · valid {paidAccess.durationSec}s after
        purchase ·{" "}
        <span
          className={`tag ${transferMode === "SURVIVE_TRANSFER" ? "ok" : "warn"}`}
        >
          {transferMode === "SURVIVE_TRANSFER"
            ? "survives transfer"
            : "invalidated on transfer"}
        </span>
      </div>
      <ul className="flex flex-wrap gap-2 text-sm">
        {perms.map(([name, allowed]) => (
          <li key={name} className={`tag ${allowed ? "ok" : "deny"}`}>
            {allowed ? "✓" : "✗"} {name}
          </li>
        ))}
      </ul>
      {props.onBuy !== undefined && (
        <button
          type="button"
          className="btn primary"
          onClick={props.onBuy}
          disabled={props.buying === true || props.disabledReason !== undefined}
          title={props.disabledReason}
        >
          {props.buying === true
            ? "paying with x402…"
            : "Buy access (x402, HBAR)"}
        </button>
      )}
      {props.disabledReason !== undefined && (
        <div className="text-sm error">{props.disabledReason}</div>
      )}
    </div>
  );
}
