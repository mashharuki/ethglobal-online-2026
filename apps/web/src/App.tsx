import { usePrivy } from "@privy-io/react-auth";
import { NavLink, Outlet } from "react-router";
import { useEmbeddedWallet } from "./chain/hooks";
import { short } from "./graph/queries";

/** Shell (tasks.md T104): nav + Privy login; every route renders inside. */
export default function App() {
  const { ready, authenticated, login, logout } = usePrivy();
  const wallet = useEmbeddedWallet();
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>TrueCollective</h1>
          <p className="text-sm">
            transfer-coupled rights runtime · Hedera Testnet
          </p>
        </div>
        <nav className="nav flex gap-1 text-sm">
          <NavLink to="/market">Market</NavLink>
          <NavLink to="/creator">Creator</NavLink>
          <NavLink to="/dashboard">Dashboard</NavLink>
        </nav>
        <div className="text-sm flex items-center gap-2">
          {!ready && <span>loading wallet…</span>}
          {ready && authenticated && (
            <>
              <code title={wallet.address}>
                {wallet.address === undefined
                  ? "no wallet"
                  : short(wallet.address)}
              </code>
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
