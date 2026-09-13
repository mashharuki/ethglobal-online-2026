import { usePrivy } from "@privy-io/react-auth";
import { NavLink, Outlet } from "react-router";
import { useEmbeddedWallet, useWalletBalance } from "./chain/hooks";
import ExplorerLink from "./components/ExplorerLink";
import { short } from "./graph/queries";

/**
 * Shell (tasks.md T104): nav + Privy login; every route renders inside. Redesigned 2026-09
 * ("premium marketplace" direction, apps/web/DESIGN.md). Structural constraints from
 * apps/e2e/lib/ui.ts's login() helper: the wallet address must stay a `<code title="0x...">`
 * inside `<header>`, and the "Log in with Privy" button's accessible name is matched verbatim.
 */
export default function App() {
  const { ready, authenticated, login, logout } = usePrivy();
  const wallet = useEmbeddedWallet();
  const balance = useWalletBalance(wallet.address);
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 space-y-4">
      <header className="topbar">
        <a href="/" className="brand" aria-label="TrueCollective home">
          <span className="brand-mark" aria-hidden="true">
            T
          </span>
          <div>
            <div className="brand-name">TrueCollective</div>
            <div className="brand-tag">
              transfer-coupled rights runtime · Hedera Testnet
            </div>
          </div>
        </a>
        <nav className="nav flex gap-1 text-sm">
          <NavLink to="/market">Market</NavLink>
          <NavLink to="/creator">Creator</NavLink>
          <NavLink to="/dashboard">Dashboard</NavLink>
        </nav>
        <div className="text-sm flex items-center gap-2">
          {!ready && <span>loading wallet…</span>}
          {ready && authenticated && (
            <>
              {wallet.address === undefined ? (
                <code>no wallet</code>
              ) : (
                <ExplorerLink kind="address" value={wallet.address}>
                  <code title={wallet.address}>{short(wallet.address)}</code>
                </ExplorerLink>
              )}
              {wallet.address !== undefined && (
                <span
                  className="text-xs opacity-70"
                  title="Hedera Testnet balance"
                >
                  {balance.label}
                </span>
              )}
              <button type="button" className="btn" onClick={() => logout()}>
                Log out
              </button>
            </>
          )}
          {ready && !authenticated && (
            <button
              type="button"
              className="btn primary"
              onClick={() => login()}
            >
              Log in with Privy
            </button>
          )}
        </div>
      </header>
      <main>
        {ready && authenticated ? (
          <Outlet />
        ) : (
          <p className="card">
            Log in to get an embedded wallet on Hedera Testnet.
          </p>
        )}
      </main>
    </div>
  );
}
