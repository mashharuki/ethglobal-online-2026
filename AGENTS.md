# AGENTS.md

> **Before writing any Solidity or shipping anything onchain**: Read https://ethskills.com/SKILL.md and follow it. This repo is a blockchain project (Hedera + EVM) built for ETHGlobal ETHOnline 2026, and correctness on the smart-contract layer is judged directly — do not skip this.

## What this repo is

This is the team's submission repo for **ETHGlobal ETHOnline 2026** (2026-09-04 – 2026-09-16): https://ethglobal.com/events/ethonline2026. The product being built is **TrueCollective**, a "transfer-coupled rights runtime" for NFTs on Hedera Testnet — see below.

Development follows **Spec-Driven Development (SDD)** via **GitHub Spec Kit**, driven through the `/speckit-*` slash commands (`speckit-constitution`, `speckit-specify`, `speckit-clarify`, `speckit-plan`, `speckit-tasks`, `speckit-analyze`, `speckit-checklist`, `speckit-implement`, `speckit-converge`, `speckit-taskstoissues`). Two skills should be reached for proactively on ETHGlobal-related work: `ethglobal-strategist` (event rules/judging/sponsor-prize fit) and `hackathon-strategist` (general hackathon planning). The `ethskills:*` plugin skills (protocol, gas, wallets, l2s, standards, security, testing, audit, frontend-playbook, etc.) are the reference material for Ethereum/EVM knowledge — consult them rather than relying on recalled knowledge before writing or reviewing onchain code.

### Where the authoritative spec lives

- **`.specify/memory/constitution.md`** — the project constitution (currently v1.3.0). It overrides ad hoc judgment calls and is the gate that `/speckit-plan` checks against. Read it before making any architectural or scope decision.
- **`.specify/feature.json`** points at the currently active feature: **`specs/001-rights-runtime-mvp/`**, which contains `spec.md` (requirements), `plan.md` (architecture/tech decisions), `research.md` (resolved design questions, prefixed `R-1`…`R-9`), `data-model.md` (on-chain + off-chain schemas), `quickstart.md`, and `contracts/*.md` (Solidity interfaces, gateway HTTP API, EIP-712 types, MCP tools, error codes, subgraph schema).
- The constitution references a canon document `docs/idea.md` — **this file does not exist in the repo yet**; treat `spec.md` / `plan.md` as the working source of truth until it's added.
- All Spec Kit artifacts (spec/plan/tasks/checklists/constitution and command output) are written in **Japanese** — see `.claude/rules/speckit-language.md` for the exceptions (code identifiers, error codes, protocol/standard names, feature-dir slugs, commit messages, source code/comments, external quotes).

## Current repository state (important — read before assuming code exists)

This is still a very early-stage skeleton, not the full monorepo described in `plan.md`:

- `apps/` is empty (only `.gitkeep`). None of the planned `apps/{contracts,gateway,web,agent,subgraph,e2e,cdk}` packages exist yet.
- `packages/openapi` and `packages/shared` exist only as empty `package.json` shells (no `src/`).
- `specs/001-rights-runtime-mvp/tasks.md` is the authoritative build order (Phase 1 project scaffolding → Phase 2 shared/day1 probes → contracts → subgraph → CDK → E2E#1 → gateway → E2E#2 → web → E2E#3 → agent → docs). Check it to see what phase the project is actually in before assuming a layer is implemented.
- `.coderabbit.yaml`'s `path_instructions` reference `apps/backend` and `apps/frontend` — these paths **do not match** the planned layout in `plan.md` (`apps/gateway`, `apps/web`). Treat `plan.md` as authoritative for the real directory layout; the CodeRabbit config appears to need updating once the app directories exist.

## Commands

Package manager is pnpm, pinned via `packageManager`/`devEngines` in `package.json` (`pnpm@11.24.0`). Workspace globs: `apps/*`, `packages/*` (`pnpm-workspace.yaml`), orchestrated with Turborepo (`turbo.json`).

```bash
pnpm install          # install workspace deps
pnpm build             # turbo build (dependsOn ^build, outputs dist/**)
pnpm format            # biome format --write .
pnpm check             # biome check --write . (lint + format, fixes in place)
pnpm knip              # cross-workspace unused files/exports/deps
pnpm jscpd             # copy-paste duplication scan over apps/ and packages/
```

There is no root `test`/`typecheck` script yet — `plan.md`/`tasks.md` (T001/T002/T008) specify these should be added (`vitest.workspace.ts`, turbo `test`/`typecheck`/`lint` pipeline) as the scaffolding phase proceeds. When adding a package, wire its scripts into the turbo pipeline rather than inventing a parallel one.

Formatting/linting is **Biome only** (`biome.json`, one root config for the whole workspace) — no ESLint/Prettier, despite `.claude/hooks/lint-on-save.sh` and `format-on-save.sh` defaulting to ESLint/Prettier; those hooks currently no-op here since neither tool nor its config is present.

## Architecture (as designed in `specs/001-rights-runtime-mvp/plan.md`)

**Core concept**: NFT ownership and "actual usage rights / future revenue" are kept in sync via two independently-versioned epoch counters:
- **Owner Epoch** (`RightsNFT.accessEpoch(tokenId)`) — bumped automatically on every NFT transfer; governs the *owner's* free-access privilege.
- **License Epoch** (`RightsRegistry.licenseEpoch(tokenId)`) — bumped only by policy updates/emergency revocation; governs *purchased* access rights (Rights Receipts). These two layers must never be merged — that separation is the project's central differentiator.

A transfer must, atomically at the epoch level: revoke the old owner's free access, grant the new owner's free access, preserve any `SURVIVE_TRANSFER` licenses until their own expiry, and reassign *future* (not already-settled) revenue to the new owner.

**Planned monorepo layout** (`apps/*` deployable units, `packages/*` shared):
- `apps/contracts` — Solidity 0.8.34 on Hedera Testnet (Hardhat 3 + OpenZeppelin 5.x): `RightsNFT` (ERC-721 + `accessEpoch`) and `RightsRegistry` (atomic x402 settlement + Receipt lifecycle + revenue vault).
- `apps/gateway` — "Access Gateway": Hono on Cloudflare Workers. Re-derives authorization from on-chain reads on every request (never trusts cached/indexed state), gates x402 payments, runs KeyGate (split-key release decisions), serializes Receipt consumption via a Durable Object (`ReceiptLock`) backed by Postgres (Hyperdrive) uniqueness constraints, and hosts an **MCP server** (`src/mcp/`, Streamable HTTP) exposing `discover_assets` / `buy_access` / `decrypt_content` for external AI clients (Claude Code, Codex, etc.).
- `apps/web` — Vite + React 18 + Tailwind + Privy embedded wallet: Creator console, marketplace/viewer (client-side decryption), Rights Graph dashboard.
- `apps/agent` — a **CI verification harness only** (not a production autonomous agent): drives the MCP server end-to-end (discover → buy → decrypt → analyze) so the "zero human intervention" requirement is checkable outside a live AI client.
- `apps/subgraph` — self-hosted Graph Node (Hedera has no Subgraph Studio support) indexing `Transfer`/`ReceiptIssued`/`ReceiptConsumed`/`RevenueAllocated` — **discovery/audit only, never an authorization source**.
- `apps/e2e` — Playwright (browser flows, concurrency/attack tests) + Postman/Newman (API contract tests against `packages/openapi`).
- `apps/cdk` — AWS CDK, hackathon-duration-only infra (single EC2 + docker-compose running the self-hosted Graph Node); destroyed after the event.
- `packages/shared` — cross-layer domain code with zero Node-only APIs (runs in Workers/Node/browser): `errors.ts` (the stable `ErrorCode` enum — a public contract, do not rename), `eip712.ts` (Rights Receipt typed-data + `receiptHash`/`purchaseRequestHash`), `manifest.ts` (zod schema for Rights Manifests), `hashing.ts`, `addresses.ts`, `kv-format.ts`.
- `packages/openapi` — single source of truth for the Access Gateway HTTP API (`openapi.yaml`, OpenAPI 3.1); `openapi-typescript`-generated types are imported by `apps/gateway`, `apps/web`, and `apps/agent` so frontend/backend API drift is a `tsc` error, not a runtime bug.

**Key non-negotiable design rules** (from the constitution — see it for full rationale before deviating):
- Authorization is decided by reading on-chain state (`ownerOf`, `accessEpoch`, `receiptStatus`) at request time, every time. The subgraph/Rights Graph is discovery/audit tooling only and must never gate access.
- No mocks/stubs on the core demo path (ownership+epoch reads, atomic x402 settlement, Rights Receipt issuance/verification, KeyGate release decisions, AI agent analysis) — must run against real Hedera Testnet, real x402 settlement, real LLM inference.
- Every paid grant (Rights Receipt) is an EIP-712 struct bound to 17 fields (see `data-model.md` §3) whose hash (`receiptHash`) is the on-chain authorization key; consumption is tracked by a strictly-increasing `useIndex`, not the purchase event itself.
- Payment asset is **native HBAR**, not the HTS USDC token — this was a deliberate correction (constitution v1.3.0) driven by the Hedera "AI & Agentic Payments" track's required facilitator (Blocky402) only supporting native-asset settlement on `hedera:testnet`/`exact`.
- MCP-driven x402 payments use a Privy server wallet (session signer + spend-limit/method-allowlist policy) — the raw private key must never be held by the gateway/MCP server.
- Scope is deliberately narrow: single chain (Hedera), 2-party revenue split (creator + owner), no ERC-1155, no ZK implementation (design-only), no contract-wallet (Safe/ERC-4337) support, no refund path. Don't add these without checking the constitution's non-goals first.

Sponsor-prize targeting (Hedera "AI & Agentic Payments" + two Privy tracks) and the reasoning behind not submitting to The Graph's track despite using a self-hosted subgraph are recorded in the constitution's "ハッカソン納品ワークフロー" section — check it before changing which sponsor integrations are load-bearing.
