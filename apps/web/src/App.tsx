import { usePrivy } from "@privy-io/react-auth";

import PremiumPanel from "./components/PremiumPanel";

function App() {
  const { ready, authenticated, login, logout } = usePrivy();

  if (!ready) {
    return <p>Loading…</p>;
  }

  return (
    <main className="app">
      <h1>x402 × Privy (Hedera testnet)</h1>
      {authenticated ? (
        <>
          <p>
            <button type="button" onClick={() => logout()}>
              Log out
            </button>
          </p>
          <PremiumPanel />
        </>
      ) : (
        <button type="button" onClick={() => login()}>
          Log in
        </button>
      )}
    </main>
  );
}

export default App;
