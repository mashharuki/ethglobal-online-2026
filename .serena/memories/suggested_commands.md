## Commands (run from repo root)

- `pnpm build` → `turbo build` (runs each workspace's `build`, none exist yet since apps/packages are empty).
- `pnpm format` → `pnpm exec biome format --write .`
- `pnpm check` → `pnpm exec biome check --write .` (lint + format + organize imports, writes fixes)
- `pnpm knip` → find unused files/exports/deps (already configured for a not-yet-created `apps/cdk` workspace).
- `pnpm jscpd` → `jscpd ./apps ./packages` (copy-paste detection).

No test runner or dev-server script exists at the root yet — add per-workspace scripts and wire them into `turbo.json` once real apps/packages land.

## Darwin-specific notes

Nothing unusual found so far (no BSD-vs-GNU sed/find/grep usage encountered yet in scripts). Revisit if shell scripts are added.