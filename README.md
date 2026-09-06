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
to the new owner. Purchases are x402 payments in **native HBAR** settled through the Blocky402
facilitator and anchored on `RightsRegistry` as an EIP-712 **Rights Receipt** before any key is
released (settle-before-release); every release is re-derived from chain reads on every request —
the Rights Graph (subgraph) is discovery and audit only, never an authorization source. Whether
payment and anchoring share one transaction depends on the rail (see below); the live settlement
path is not yet verified.

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
3. `POST /assets/{assetId}/paid` with `X-PAYMENT` → the gateway verifies and settles the HBAR
   transfer through the **Blocky402** facilitator, then its operator anchors the receipt on
   `RightsRegistry` in a second transaction (`ReceiptIssued`, `RevenueAllocated` to creator +
   *current* owner). The receipt is returned only after that anchor is confirmed, and the payment
   binding (`payment_id`, stage, claim) makes retries idempotent. This is the default
   **custodial rail**; the contract also implements the single-transaction
   `settleAndIssue{value}` rail (payment and receipt in one call) and the `payFor` + `finalize`
   rail, selectable by `SETTLEMENT_MODE`. **None of the three has been exercised against the live
   facilitator yet** (day-1 probe pending).
4. `POST /keygate/share` (licensee path) → `ReceiptLock` serialises the receipt, `consume` is
   submitted on-chain by the operator queue, and only then the blinded key share is released;
   the client recovers `K = share_G XOR share_U` and decrypts AES-256-GCM locally.

Twenty concurrent shares of the same receipt must end with **1 settled / 19 rejected**
(`RECEIPT_ALREADY_CONSUMED` / `SETTLEMENT_IN_PROGRESS`, HTTP 409), enforced by three layers:
Durable Object serialisation, a Postgres uniqueness constraint, and the contract's `consume`.
This is verified today with real parallelism in the contract suite (Hardhat) and the gateway suite
(workerd + PGlite); the same burst against the deployed gateway is the pending acceptance
criterion in `apps/e2e/attacks.e2e.ts`.

## AI agent through MCP

The gateway hosts an MCP server (Streamable HTTP) with three tools: `discover_assets`,
`buy_access`, `decrypt_content`, designed so an MCP client can run the whole flow with no human
step; the receipt bought in a session can only be decrypted by that session
(`MCP_SESSION_MISMATCH` otherwise), and spending is capped per session
(`MCP_SESSION_SPEND_CAP_TINYBAR`). The tools, the session binding and the cap are covered by the
gateway's unit suite (real MCP SDK transport, in-process); the zero-human live run is the pending
acceptance criterion in `apps/agent`.

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
itself (see its README); it skips, with a notice, until a gateway and an API key are configured.

## Trust model (please read before judging)

Stated as precisely as we can (constitution VII):

- **What is trustless:** ownership, Owner / License epochs, receipt issuance, consumption
  (`useIndex`), and revenue allocation are on-chain (`RightsNFT`, `RightsRegistry`); the gateway
  re-reads `ownerOf` / `accessEpoch` / `receiptStatus` at request time, never a cache.
- **What the gateway holds:** the receipt signing key (a convenience credential; the chain is the
  authority), the operator key that submits `consume` and anchors receipts, the `share_U` half of
  each content key (Workers Secrets, handed out blinded per wallet) and the encrypted `share_G`
  half (KV). In normal operation it never assembles `K` (it lacks the wallet's KeyGate
  signature); a **compromised** gateway that reads both halves can reconstruct `K` for any asset
  and serve content on either path. That is the known residual trust point (Shamir 2-of-3 is the
  planned follow-up, not implemented). What a compromise cannot do is break the on-chain
  invariants: double-consume a `(receiptHash, useIndex)`, exceed `maxUses` / expiry /
  `licenseEpoch`, or issue a receipt without the contract's required payment.
- **KeyGate fallback:** while the plain fallback release path is enabled the gateway handles the
  full key; the demo runs the blinded-share path.
- **Availability:** the gateway is a single point of failure for key release (not for ownership
  or revenue, which stay on-chain).
- **Payment rail:** the default rail is the custodial x402 settlement through Blocky402 (native
  HBAR only — the Hedera "AI & Agentic Payments" track's facilitator does not settle HTS tokens):
  between settlement and anchoring the HBAR sits with the facilitator / operator, not in the
  contract. The `payFor` + permissionless `finalize` rail keeps the deposit in `RightsRegistry`
  (non-atomic, non-custodial), and `settleAndIssue{value}` is the single-transaction rail; all
  three are implemented and selectable, and none is live-verified yet (`apps/gateway/CONFIG.md`).
- **MCP wallet:** the MCP tools are unauthenticated (demo). Purchases are signed by a Privy
  server wallet under a per-session spend cap; the raw key is never held by the gateway, but
  anyone who can reach the URL can spend up to the cap.
- **Rights Graph:** self-hosted Graph Node on AWS EC2 (`apps/cdk`), **runs only for the hackathon
  and is destroyed afterwards** with `pnpm --filter cdk destroy`. It is discovery / audit only.
- **Not supported:** contract wallets (Safe / ERC-4337, no ERC-1271), refunds of completed
  purchases (the fallback rail's `refundUnfinalized` only returns a deposit that was never
  finalized), ERC-1155, multi-chain, ZK (design only), any DRM claim, legal copyright transfer.
- **Claim scope:** TrueCollective implements request-binding, idempotency, settle-before-release
  and concurrency control in a Rights Gateway. It does not claim to have "made x402 safe".

## Deploy

| Layer | Command | Notes |
|---|---|---|
| Contracts | `pnpm --filter contracts exec hardhat run scripts/deploy.ts --network testnet`, then `pnpm --filter contracts exec hardhat run scripts/seed.ts --network testnet` | writes addresses back to `packages/shared` / subgraph config; verify on HashScan |
| Graph Node | `pnpm --filter cdk deploy` → `pnpm --filter subgraph deploy` | hackathon only; **`pnpm --filter cdk destroy` after the event** |
| Gateway | `pnpm --filter gateway deploy`, then `pnpm --filter gateway exec tsx scripts/load-shares.ts` (loads the seeded key shares into KV / secrets), then `pnpm --filter gateway deploy` again | secrets in `apps/gateway/CONFIG.md` |
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

- Commits in this repository start on **2026-09-05** (`git log --reverse`): every file under
  `apps/` and `packages/` was committed after the event opened. That is a statement about
  repository timing, not authorship — the boilerplate listed next predates the event and was
  not written by us.
- Before the event: the design and spec documents under `specs/` and `.specify/` (written
  2026-09-02 → 03 with Spec Kit, allowed by the ETHOnline AI policy), the `.claude/` agent
  configuration, and public boilerplate copied from the `hedra-sample` collection of Hedera
  examples: `hardhat-erc-721-mint` (the base of `apps/contracts`' Hardhat config and the first
  mint script), `hedera-subgraph-example` (the base of `apps/subgraph`'s manifest, mappings
  pattern and Graph Node docker-compose, and of `apps/cdk`'s EC2 stack), and an x402 + Privy web
  sample (the base of `apps/web`'s Privy signer / Hedera transfer helpers). Everything specific
  to TrueCollective (contracts, gateway, MCP server, KeyGate, web routes, e2e, agent) was
  written during the event.
- AI tools: Claude Code (implementation) and Codex (review) were used throughout.

## Sponsor tracks

Hedera "AI & Agentic Payments" (x402-gated service on Hedera Testnet through Blocky402, native
HBAR), Privy "Best Financial Flow" (embedded wallet at the core of the payment flow), Privy "Best
B2B Financial Product" (MCP payment wallet under Privy session signer + spend policy). The Graph
track is intentionally not entered (self-hosted node, Hedera unsupported by Subgraph Studio).
