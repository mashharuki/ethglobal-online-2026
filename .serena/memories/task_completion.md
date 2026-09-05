## Before considering a change done

1. `pnpm check` (Biome lint+format+organize-imports, writes fixes) — this is the only configured quality gate at root right now.
2. `pnpm build` if any workspace now has a `build` script (turbo will no-op for workspaces without one).
3. `pnpm knip` if you added/removed files or deps, to catch unused exports — note its config currently only scopes `apps/cdk`, so update `knip.json` workspaces when new apps/packages are added.

No test suite exists yet at the root level — if you add one to a workspace, also add a corresponding `test` task to `turbo.json` and update this memory.