## Project

ethglobal-online-2026 — hackathon repo for ETH Global Online 2026. Pnpm/Turborepo monorepo, currently a **bare skeleton**: `apps/` and `packages/` each contain only a `.gitkeep`, no real code yet.

## Source map

- `apps/*` — intended app packages (workspace glob, currently empty).
- `packages/*` — intended shared packages (workspace glob, currently empty).
- `knip.json` already references a planned `apps/cdk` workspace (`bin/*.ts`, `scripts/*.ts`, `test/**/*.test.ts`) — signals an AWS CDK app is the next thing expected to land under `apps/`, even though it doesn't exist yet.
- Root-level tooling only: `package.json`, `turbo.json`, `biome.json`, `knip.json`, `pnpm-workspace.yaml`.

## More memories

- `mem:tech_stack` — package manager/build tool versions and pins.
- `mem:suggested_commands` — root scripts (build/format/check/knip/jscpd) and Darwin-specific shell notes.
- `mem:task_completion` — what to run before considering a change done.

No `mem:conventions` yet — there is no application code to derive conventions from; revisit once `apps/*` or `packages/*` gain real content.