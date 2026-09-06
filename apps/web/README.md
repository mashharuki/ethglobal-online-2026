# web - TrueCollective UI (Vite + React + Privy)

Creator console, marketplace / viewer and Rights Graph dashboard (tasks.md Phase 9). Every
gateway call goes through the openapi-typed client in `src/api/client.ts`; every "who owns this
and in which epoch" fact is read from Hedera through viem (`src/chain/hooks.ts`), never from a
cache; the Rights Graph is used for discovery and the dashboard only (FR-020).

## Setup

```sh
cp .env.example .env
```

| variable | purpose |
|---|---|
| `VITE_PRIVY_APP_ID` | Privy app (embedded EVM wallet on Hedera Testnet) - the same app the gateway MCP wallet uses |
| `VITE_GATEWAY_URL` | Access Gateway base URL (`wrangler dev`: `http://localhost:8787`) |
| `VITE_HEDERA_RPC_URL` | JSON-RPC relay (default `https://testnet.hashio.io/api`) |
| `VITE_RIGHTS_NFT_ADDRESS` / `VITE_RIGHTS_REGISTRY_ADDRESS` | optional; default = `packages/shared` deploy write-back |
| `VITE_IPFS_GATEWAY_URL` | optional; default `https://ipfs.io` |

Privy dashboard: one login method, embedded wallets (EVM) enabled. The wallet's EVM address
needs a funded Hedera Testnet account; a hollow account is activated from the Market page
(one 1-tinybar transfer signed by the wallet).

## Routes

| route | what it does |
|---|---|
| `/market` | `GET /assets` listing, preview link, **Buy access** (402 -> Privy-signed HBAR transfer -> `POST /assets/{id}/paid`), **Access as owner** |
| `/viewer/:assetId?path=owner` | owner path: challenge -> EIP-712 signature -> `/owner/keygate` -> `share_G` + `blindedU` -> unblind + AES-GCM in the browser |
| `/viewer/:assetId?path=licensee&receipt=0x…` | licensee path: `/keygate/challenge` -> `/keygate/share` (one `consume`) -> decrypt; shows the use index |
| `/creator` | encrypt a dataset locally, split K, predict the tokenId (simulated mint), build + validate the Rights Manifest, download `content.enc` / `manifest.json` / `shares.json`, mint |
| `/dashboard` | Rights Graph timeline (two epoch lanes), receipts / allocations, the 20-parallel replay counter, `GET /audit` |

The `RightsBadge` on the viewer is computed from a fresh `ownerOf` / `accessEpoch` /
`licenseEpoch` read pinned to one block (constitution II); the `EpochTimeline` is indexed data
and is labelled as such.

## Scripts

```sh
pnpm --filter web dev      # vite
pnpm --filter web test     # vitest (node env: keygate round trip, x402 payload, client, graph, creator)
pnpm --filter web build    # tsc -b && vite build
```

Design tokens and rules: `DESIGN.md`.
