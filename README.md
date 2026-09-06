# TrueCollective — transfer-coupled rights runtime for NFTs on Hedera

ETHGlobal **ETHOnline 2026** submission (2026-09-04 → 2026-09-16, https://ethglobal.com/events/ethonline2026).

**One sentence:** when an NFT is transferred, the *actual right to use the content* (free owner
access, paid licenses, future revenue) switches with it — atomically at the epoch level, without
re-encrypting anything — and an AI agent can buy and use that right on its own through MCP.

Two independent epoch counters keep ownership and usage in sync:

| Counter | Where | Bumped by | Governs |
|---|---|---|---|
| **Owner Epoch** `RightsNFT.accessEpoch(tokenId)` | ERC-721 `_update` only (no setter) | every transfer | the owner's free access |
| **License Epoch** `RightsRegistry.licenseEpoch(tokenId)` | creator / emergency revocation | policy updates | purchased Rights Receipts |

A transfer revokes the old owner, grants the new owner, keeps `SURVIVE_TRANSFER` licenses alive
until their own expiry, invalidates `INVALIDATE_ON_TRANSFER` ones, and reassigns *future* revenue
to the new owner. Purchases are x402 payments in **native HBAR**, settled in one Hedera transaction
that also issues an EIP-712 **Rights Receipt**; decryption keys are released only after the
on-chain state says so (settle-before-release), and every release is re-derived from chain reads
on every request — the Rights Graph (subgraph) is discovery and audit only, never an authorization
source.

## Repository layout

| Package | Role | Docs |
|---|---|---|
| `apps/contracts` | Solidity 0.8.34 (Hardhat 3, OpenZeppelin 5): `RightsNFT`, `RightsRegistry` (x402 settlement, receipt lifecycle, revenue vault), deploy / seed / day-1 probe scripts | [README](apps/contracts/README.md) |
| `apps/gateway` | Access Gateway: Hono on Cloudflare Workers. Owner + licensee KeyGate, x402 rail (Blocky402), `ReceiptLock` / `OperatorTxQueue` Durable Objects, Postgres (Hyperdrive), audit log, **MCP server** at `/mcp` | [CONFIG](apps/gateway/CONFIG.md) |
| `apps/web` | Vite + React + Tailwind + Privy embedded wallet: Creator console, Market / Viewer (client-side decryption), Rights Graph dashboard, attack counter | [README](apps/web/README.md) |
| `apps/subgraph` | Rights Graph on a self-hosted Graph Node (Hedera has no Subgraph Studio support) | [README](apps/subgraph/README.md) |
| `apps/cdk` | AWS CDK: one EC2 + docker-compose running the Graph Node, **hackathon-duration only** | [README](apps/cdk/README.md) |
| `apps/e2e` | Playwright browser / attack / demo-script specs, Newman API contract suite, latency metrics | [README](apps/e2e/README.md) |
| `apps/agent` | CI verification harness: MCP client → discover / buy / decrypt → Claude analysis → harness-side verification | [README](apps/agent/README.md) |
| `packages/shared` | Cross-layer domain code (error codes, EIP-712 types + `receiptHash`, manifest schema, hashing, KeyGate maths, KV format) | — |
| `packages/openapi` | Single source of truth for the gateway HTTP API (OpenAPI 3.1 → generated types used by gateway, web, agent) | — |
| `specs/001-rights-runtime-mvp` | Spec-Driven Development artifacts (spec, plan, research, data model, contracts, tasks, quickstart, pitch Q&A) — in Japanese | [quickstart](specs/001-rights-runtime-mvp/quickstart.md) |

```bash
pnpm install
pnpm check        # biome
pnpm knip && pnpm jscpd
pnpm -r typecheck
pnpm -r test      # unit tests of every package (network-bound specs skip with a printed notice)
```

## How a purchase works (x402, native HBAR)

1. `GET /assets/{assetId}/paid` → **402** with an x402 v2 `accepts` entry: `scheme: exact`,
   `network: hedera:testnet`, `amount` in tinybar, `payTo`, and the exact Rights Receipt quote
   (`extra.receiptQuote`, nonce fixed at quote time).
2. The buyer signs a Hedera `TransferTransaction` for that amount — from the browser with the
   Privy embedded wallet, from Node with the seeded account, or from the MCP server with the
   gateway's Privy **server wallet** (session signer + spend cap, never a raw key).
3. `POST /assets/{assetId}/paid` with `X-PAYMENT` → the gateway verifies and settles through the
   **Blocky402** facilitator, anchors the receipt on `RightsRegistry` (`ReceiptIssued`,
   `RevenueAllocated` to creator + *current* owner), records the payment binding idempotently,
   and returns the server-signed receipt.
4. `POST /keygate/share` (licensee path) → `ReceiptLock` serialises the receipt, `consume` is
   submitted on-chain by the operator queue, and only then the blinded key share is released;
   the client recovers `K = share_G XOR share_U` and decrypts AES-256-GCM locally.

Twenty concurrent shares of the same receipt end with **1 settled / 19 rejected**
(`RECEIPT_ALREADY_CONSUMED` / `SETTLEMENT_IN_PROGRESS`, HTTP 409), enforced by three layers:
Durable Object serialisation, a Postgres uniqueness constraint, and the contract's `consume`.

## AI agent through MCP

The gateway hosts an MCP server (Streamable HTTP) with three tools: `discover_assets`,
`buy_access`, `decrypt_content`. Any MCP client can run the whole flow with no human step; the
receipt bought in a session can only be decrypted by that session (`MCP_SESSION_MISMATCH`
otherwise), and spending is capped per session (`MCP_SESSION_SPEND_CAP_TINYBAR`).

`mcp.json` for a generic client:

```json
{
  "mcpServers": {
    "rights-runtime": {
      "type": "http",
      "url": "https://<your-gateway>.workers.dev/mcp"
    }
  }
}
```

With Claude Code the same server is registered by the `claude mcp add --transport http rights-runtime https://<your-gateway>.workers.dev/mcp` command.
`apps/agent` reproduces this in CI and verifies the model's answer against the decrypted data
itself (see its README).

## Trust model (please read before judging)

Stated as precisely as we can (constitution VII):

- **What is trustless:** ownership, Owner / License epochs, receipt issuance, consumption
  (`useIndex`), and revenue allocation are on-chain (`RightsNFT`, `RightsRegistry`); the gateway
  re-reads `ownerOf` / `accessEpoch` / `receiptStatus` at request time, never a cache.
- **What the gateway holds:** the receipt signing key (a convenience credential; the chain is the
  authority), the operator key that submits `consume`, and — for the **owner (free) path** — the
  `share_U` half of each content key, blinded per wallet. A compromised gateway could therefore
  serve owner-path content; this is the known residual trust point (Shamir 2-of-3 is the planned
  follow-up, not implemented).
- **KeyGate fallback:** while the plain fallback release path is enabled the gateway handles the
  full key; the demo runs the blinded-share path.
- **Availability:** the gateway is a single point of failure for key release (not for ownership
  or revenue, which stay on-chain).
- **Payment rail:** the default rail is the custodial x402 settlement through Blocky402 (native
  HBAR only — the Hedera "AI & Agentic Payments" track's facilitator does not settle HTS tokens);
  the non-atomic `payFor` + permissionless `finalize` rail is implemented in the contracts and
  selectable, both are disclosed in `apps/gateway/CONFIG.md`.
- **MCP wallet:** the MCP tools are unauthenticated (demo). Purchases are signed by a Privy
  server wallet under a per-session spend cap; the raw key is never held by the gateway, but
  anyone who can reach the URL can spend up to the cap.
- **Rights Graph:** self-hosted Graph Node on AWS EC2 (`apps/cdk`), **runs only for the hackathon
  and is destroyed afterwards** with `pnpm --filter cdk destroy`. It is discovery / audit only.
- **Not supported:** contract wallets (Safe / ERC-4337, no ERC-1271), refunds, ERC-1155,
  multi-chain, ZK (design only), any DRM claim, legal copyright transfer.
- **Claim scope:** TrueCollective implements request-binding, idempotency, settle-before-release
  and concurrency control in a Rights Gateway. It does not claim to have "made x402 safe".

## Deploy

| Layer | Command | Notes |
|---|---|---|
| Contracts | `pnpm --filter contracts exec hardhat run scripts/deploy.ts --network testnet` then `scripts/seed.ts` | writes addresses back to `packages/shared` / subgraph config; verify on HashScan |
| Graph Node | `pnpm --filter cdk deploy` → `pnpm --filter subgraph deploy` | hackathon only; **`pnpm --filter cdk destroy` after the event** |
| Gateway | `pnpm --filter gateway deploy` then `scripts/load-shares.ts`, redeploy | secrets in `apps/gateway/CONFIG.md` |
| Web | `pnpm --filter web build` → Cloudflare Pages | `VITE_*` in `apps/web/README.md` |

## Verification status (honest)

Everything below the network boundary is verified locally and in review: contract test suites,
gateway (workerd + PGlite) suites incl. the 20-parallel replay, web unit tests, e2e tooling
tests, agent unit tests, biome / knip / jscpd / typecheck all green, every PR reviewed by a second
model (GPT-6 Astra via Codex) until clean.

**Not yet verified at the time of writing (needs credentials / deployments):** Hedera Testnet
day-1 probes, contract deployment + seed on Testnet, Blocky402 settlement, Cloudflare deployment,
Privy live login, the AWS Graph Node, the live Playwright / Newman / agent runs. Those specs
**skip with a printed notice and never report success** until the targets exist.

## Prior work and disclosure (ETHOnline rules)

- Implementation commits start on **2026-09-05** (`git log --reverse`); nothing in `apps/` or
  `packages/` predates the event.
- Before the event: the design and spec documents under `specs/` and `.specify/` (written
  2026-09-02 → 03 with Spec Kit, allowed by the ETHOnline AI policy), the `.claude/` agent
  configuration, and public boilerplate from `hedra-sample` (Hardhat ERC-721 mint, Hedera
  subgraph example, x402 + Privy web sample) used as starting templates.
- AI tools: Claude Code (implementation) and Codex (review) were used throughout.

## Sponsor tracks

Hedera "AI & Agentic Payments" (x402-gated service on Hedera Testnet through Blocky402, native
HBAR), Privy "Best Financial Flow" (embedded wallet at the core of the payment flow), Privy "Best
B2B Financial Product" (MCP payment wallet under Privy session signer + spend policy). The Graph
track is intentionally not entered (self-hosted node, Hedera unsupported by Subgraph Studio).
