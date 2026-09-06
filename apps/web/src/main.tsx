import { PrivyProvider } from "@privy-io/react-auth";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";

import App from "./App.tsx";
import { getConfig } from "./config.ts";
import "./css/index.css";
import Creator from "./routes/Creator.tsx";
import Dashboard from "./routes/Dashboard.tsx";
import Market from "./routes/Market.tsx";
import Viewer from "./routes/Viewer.tsx";

const router = createBrowserRouter([
  {
    path: "/",
    Component: App,
    children: [
      { index: true, element: <Navigate to="/market" replace /> },
      { path: "market", Component: Market },
      { path: "creator", Component: Creator },
      { path: "viewer/:assetId", Component: Viewer },
      { path: "dashboard", Component: Dashboard },
    ],
  },
]);

const root = document.getElementById("root");
if (root === null) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <PrivyProvider
      appId={getConfig().privyAppId}
      config={{
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      <RouterProvider router={router} />
    </PrivyProvider>
  </StrictMode>,
);
