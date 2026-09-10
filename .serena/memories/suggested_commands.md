## Root commands (turbo-orchestrated, real pipelines now — not no-ops)

- `pnpm build` → `turbo build` (deps on `^build`/`^compile`/`^generate`, so contracts compile + openapi generate run first).
- `pnpm test` → `turbo test` (per-workspace `test`; contracts' `test` task additionally depends on `typecheck`).
- `pnpm lint` → `turbo lint` (deps on `^generate`).
- `pnpm typecheck` → `turbo typecheck`.
- `pnpm dev` → `turbo dev` (persistent, uncached — gateway `wrangler dev` / web `vite` / etc.).
- `pnpm format` → `biome format --write .`; `pnpm check` → `biome check --write .` (fix lint+format+imports).
- `pnpm ci` → `biome ci . && pnpm knip && pnpm jscpd` (the CI-equivalent local gate).
- `pnpm knip` / `pnpm jscpd` — unused-code / duplication scans, config per workspace in `knip.json` / `.jscpd.json`.
- `pnpm audit:no-mocks` (`AUDIT_STRICT=1 bash scripts/audit-no-mocks.sh`) — greps core demo path for mocks/stubs.
- Per-workspace filters: `pnpm web`, `pnpm contracts`, `pnpm gateway`, `pnpm agent`, `pnpm subgraph`, `pnpm cdk`, `pnpm e2e`, `pnpm shared` (→ `@truenft/shared`), `pnpm openapi` (→ `@truenft/openapi`) — each is `pnpm --filter <name>`, chain a script after it, e.g. `pnpm gateway test:pg`.

## Common per-workspace scripts worth knowing (full command form: `pnpm --filter <workspace> <script>`)

- `contracts`: `compile` (`bunx hardhat build`), `test`, `deploy:testnet`, `seed:testnet` / `seed:testnet:lean`, `probe:hedera`, `verify:testnet`, `smoke:local` (deploy+seed+probe against a local node).
- `gateway`: `dev` (`wrangler dev`), `deploy` (`wrangler deploy`), `test` (workerd+node), `test:pg` (real Postgres, run separately), `sync-abis`, `db:generate`/`db:migrate` (Drizzle), `load-shares` (push KeyGate shares to Workers KV/Secrets Store).
- `web`: `dev`, `build` (`tsc -b && vite build`), `lint` (`oxlint`, not biome).
- `subgraph`: `manifest` (render `subgraph.yaml` from template), `codegen`, `build`, `deploy`, `graph-node` / `graph-node:down` (local docker-compose graph-node for dev).
- `cdk`: `synth`, `deploy` (`cdk deploy GraphNodeStack --require-approval never`), `destroy`.
- `e2e`: `test` (Playwright), `test:unit` (Vitest), `test:api` (Newman against `postman/gateway.postman_collection.json`).
- `openapi`: `generate` (openapi-typescript → `src/types.ts`), `sync-errors` / `check-errors` (keep `ErrorCode` enum in sync with `packages/shared`), `lint` (`redocly lint openapi.yaml`).

## Darwin-specific notes

Nothing BSD-vs-GNU-specific found in scripts so far. `apps/contracts` requires Bun on PATH (see `mem:tech_stack`) in addition to pnpm.