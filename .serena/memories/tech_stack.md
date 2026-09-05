## Tech stack

- Package manager: pnpm, pinned via `devEngines.packageManager` and `packageManager` field to `pnpm@11.24.0` (root `package.json`) — do not use npm/yarn.
- Monorepo/build orchestration: Turborepo (`turbo` ^2.10.12), single `build` task defined in `turbo.json` (depends on `^build`, outputs `dist/**`). No `dev`/`test`/`lint` turbo tasks defined yet — add them to `turbo.json` when apps/packages exist.
- Workspaces: `apps/*` and `packages/*` (`pnpm-workspace.yaml`).
- Linter/formatter: Biome 2.5.9 (`@biomejs/biome`), config in `biome.json` — recommended preset, double quotes for JS, organizeImports on, VCS integration disabled (`vcs.enabled: false`).
- Unused-code detection: `knip` ^6.32.2, config in `knip.json` — already declares an `apps/cdk` workspace entry (AWS CDK app) that doesn't exist on disk yet.
- Duplication detection: `jscpd` (run via root script, not in devDependencies list — likely invoked via `pnpm dlx` or expected to be installed later).
- Root `package.json` has `"type": "module"`.