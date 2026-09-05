import { PrivyProvider } from "@privy-io/react-auth";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.tsx";
import { getConfig } from "./config.ts";
import "./css/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PrivyProvider
      appId={getConfig().privyAppId}
      config={{
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      <App />
    </PrivyProvider>
  </StrictMode>,
);
