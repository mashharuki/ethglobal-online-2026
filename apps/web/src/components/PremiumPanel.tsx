import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";

import { getConfig } from "../config";
import { activateHollowAccount } from "../hedera/activateAccount";
import type { ResolvedHederaAccount } from "../hedera/resolveAccount";
import { resolveHederaAccount } from "../hedera/resolveAccount";
import { type PayPremiumResult, payPremium } from "../x402/payPremium";
import {
  createPrivyHederaSigner,
  recoverWalletPublicKey,
  type SignRawHash,
} from "../x402/privyHederaSigner";
import { formatHbar } from "./formatHbar";

type Phase =
  | { kind: "resolving" }
  | { kind: "unfunded"; evmAddress: string }
  | { kind: "needs-activation"; account: ResolvedHederaAccount }
  | { kind: "activating"; account: ResolvedHederaAccount }
  | { kind: "ready"; account: ResolvedHederaAccount }
  | { kind: "paying"; account: ResolvedHederaAccount }
  | { kind: "done"; account: ResolvedHederaAccount; result: PayPremiumResult }
  | { kind: "error"; message: string };

export default function PremiumPanel() {
  const config = getConfig();
  const { user } = usePrivy();
  const { wallets } = useWallets();
  const embedded = wallets.find(
    (wallet) => wallet.walletClientType === "privy",
  );
  const evmAddress = embedded?.address ?? user?.wallet?.address ?? "";

  const [phase, setPhase] = useState<Phase>({ kind: "resolving" });

  const refresh = useCallback(async () => {
    if (!evmAddress) {
      return;
    }
    setPhase({ kind: "resolving" });
    try {
      const account = await resolveHederaAccount(
        evmAddress,
        config.mirrorNodeUrl,
      );
      if (!account) {
        setPhase({ kind: "unfunded", evmAddress });
      } else if (!account.hasKey) {
        setPhase({ kind: "needs-activation", account });
      } else {
        setPhase({ kind: "ready", account });
      }
    } catch (error) {
      setPhase({ kind: "error", message: describeError(error) });
    }
  }, [evmAddress, config.mirrorNodeUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const getSignRawHash = useCallback(async (): Promise<SignRawHash> => {
    if (!embedded) {
      throw new Error("Privy embedded wallet is not available");
    }
    const provider = await embedded.getEthereumProvider();
    return async (hashHex) =>
      (await provider.request({
        method: "secp256k1_sign",
        params: [hashHex],
      })) as string;
  }, [embedded]);

  const activate = useCallback(async () => {
    if (phase.kind !== "needs-activation" || !embedded) {
      return;
    }
    const account = phase.account;
    setPhase({ kind: "activating", account });
    try {
      const signRawHash = await getSignRawHash();
      const publicKey = await recoverWalletPublicKey(evmAddress, signRawHash);
      await activateHollowAccount(account.accountId, publicKey, signRawHash);
      await refresh();
    } catch (error) {
      setPhase({ kind: "error", message: describeError(error) });
    }
  }, [phase, embedded, evmAddress, getSignRawHash, refresh]);

  const pay = useCallback(async () => {
    if (phase.kind !== "ready" || !embedded) {
      return;
    }
    const account = phase.account;
    setPhase({ kind: "paying", account });
    try {
      const signRawHash = await getSignRawHash();
      const signer = createPrivyHederaSigner({
        accountId: account.accountId,
        evmAddress,
        signRawHash,
      });
      const result = await payPremium(signer, config.resourceServerUrl);
      setPhase({ kind: "done", account, result });
    } catch (error) {
      setPhase({ kind: "error", message: describeError(error) });
    }
  }, [phase, embedded, evmAddress, getSignRawHash, config.resourceServerUrl]);

  return (
    <section className="panel">
      <p>
        Wallet: <code>{evmAddress || "—"}</code>
      </p>
      {phase.kind === "resolving" && <p>Resolving Hedera account…</p>}

      {phase.kind === "unfunded" && (
        <div>
          <p>
            この EVM アドレスに対応する Hedera testnet 口座がまだありません。
            次を実行して資金を投入してください:
          </p>
          <code>pnpm --filter frontend run fund {phase.evmAddress}</code>
          <p>
            <button type="button" onClick={() => void refresh()}>
              再確認
            </button>
          </p>
        </div>
      )}

      {(phase.kind === "needs-activation" || phase.kind === "activating") && (
        <div>
          <p>
            Account: <code>{phase.account.accountId}</code> — balance{" "}
            {formatHbar(phase.account.balanceTinybars)}
          </p>
          <p>
            この口座は資金は入っていますが、まだ有効化されていません（hollow
            account）。オンチェーンに公開鍵が無いため x402
            の支払いを検証できません。 有効化すると、ウォレットの鍵で 1 tinybar
            のトランザクションを1回送信し、 鍵をオンチェーンに登録します。
          </p>
          <button
            type="button"
            onClick={() => void activate()}
            disabled={phase.kind === "activating" || !embedded}
          >
            {phase.kind === "activating" ? "有効化中…" : "アカウントを有効化"}
          </button>
        </div>
      )}

      {(phase.kind === "ready" ||
        phase.kind === "paying" ||
        phase.kind === "done") && (
        <div>
          <p>
            Account: <code>{phase.account.accountId}</code> — balance{" "}
            {formatHbar(phase.account.balanceTinybars)}
          </p>
          {phase.kind !== "done" && (
            <button
              type="button"
              onClick={() => void pay()}
              disabled={phase.kind === "paying" || !embedded}
            >
              {phase.kind === "paying"
                ? "支払い中…"
                : "支払って /premium を取得"}
            </button>
          )}
        </div>
      )}

      {phase.kind === "done" && (
        <div>
          <h2>Response</h2>
          <pre>{JSON.stringify(phase.result.body, null, 2)}</pre>
          <h2>Settlement</h2>
          <pre>{JSON.stringify(phase.result.settlement, null, 2)}</pre>
          {settlementTxId(phase.result.settlement) && (
            <p>
              <a
                href={`https://hashscan.io/testnet/transaction/${settlementTxId(
                  phase.result.settlement,
                )}`}
                target="_blank"
                rel="noreferrer"
              >
                HashScan で確認
              </a>
            </p>
          )}
          <p>
            <button type="button" onClick={() => void refresh()}>
              もう一度
            </button>
          </p>
        </div>
      )}

      {phase.kind === "error" && (
        <div>
          <p className="error">エラー: {phase.message}</p>
          <button type="button" onClick={() => void refresh()}>
            やり直す
          </button>
        </div>
      )}
    </section>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settlementTxId(settlement: unknown): string | null {
  if (settlement && typeof settlement === "object") {
    const value = (settlement as Record<string, unknown>).transaction;
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}
