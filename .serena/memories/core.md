## Project

ethglobal-online-2026 — submission repo for ETHGlobal ETHOnline 2026, product **TrueCollective** (transfer-coupled rights runtime for NFTs on Hedera Testnet). Full architecture/design rules live in `AGENTS.md` (root, auto-loaded into every session) — **do not duplicate that content here**; this memory only tracks what AGENTS.md doesn't cover (current implementation reality, per-workspace commands, non-obvious tooling).

**No longer a skeleton.** All 8 planned workspaces now contain real implementation (as of 2026-09-10):

- `apps/contracts` — Hardhat 3 Solidity, `RightsNFT` + `RightsRegistry`, tests/scripts present.
- `apps/gateway` — Hono on Cloudflare Workers, MCP server (`src/mcp/`), KeyGate, x402 settlement.
- `apps/web` — Vite + React 18 + Tailwind + Privy.
- `apps/subgraph` — self-hosted Graph Node indexer, mappings implemented.
- `apps/cdk` — AWS CDK stack for the self-hosted Graph Node EC2 box.
- `apps/agent` — CI verification harness (MCP client + Claude).
- `apps/e2e` — Playwright + Postman/Newman.
- `packages/shared` — `errors.ts` / `eip712.ts` / `manifest.ts` / `hashing.ts` / `addresses.ts` / `kv-format.ts` / `keygate.ts` / `secp256k1.ts`.
- `packages/openapi` — `openapi.yaml` SoT + generated `src/types.ts`.

Source of truth for exactly what's built vs. what's left is `specs/001-rights-runtime-mvp/tasks.md` (checkbox list) — see `mem:project_status` for a snapshot and how to re-check it (this drifts fast, re-verify against tasks.md rather than trusting the snapshot for long).

## More memories

- `mem:tech_stack` — per-workspace tooling/runtime details not obvious from AGENTS.md (mixed pnpm/bun usage, per-workspace lint/test tool choices, multi-config vitest in gateway).
- `mem:suggested_commands` — real root + per-workspace scripts now that turbo pipelines are wired up.
- `mem:task_completion` — quality gate to run before considering a change done.
- `mem:project_status` — snapshot of tasks.md completion (which phases/tasks remain), with re-verification instructions.

No `mem:conventions` — code-level conventions are covered by `.claude/rules/code-style.md`, `.claude/rules/testing.md`, and the constitution (`.specify/memory/constitution.md`); don't duplicate those into Serena memory.