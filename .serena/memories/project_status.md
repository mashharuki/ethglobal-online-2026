## Snapshot (as of 2026-09-10 — re-verify against `specs/001-rights-runtime-mvp/tasks.md` before relying on this, it drifts fast)

114/129 tasks checked `[x]` in `tasks.md`. All 12 phases have implementation work done; what remains is mostly **deployment / final-verification / submission steps**, not new feature code:

- Phase 2 day1 probes T019–T021 are unchecked (gateway/workerd MCP probe, x402/Blocky402 probe, graph-node probe) despite later phases being implemented — check whether these were actually superseded by real implementation or are genuinely still open before assuming they're stale checkboxes.
- Remaining deploy/seed tasks: T047 (`deploy.ts` to Testnet + write back addresses), T048 (`seed.ts` demo accounts/assets), T056/T057 (CDK `deploy GraphNodeStack` + subgraph `graph deploy`), T097 (gateway `wrangler deploy` + `load-shares`), T099 (Newman against deployed gateway).
- Remaining E2E-against-real-deploy gates: T119 (Playwright against real web+gateway+Graph Node+Testnet).
- Remaining submission tasks: T124 (quickstart.md DoD checklist), T125 (full `pnpm run check` green including `redocly lint` + `newman`), T126 (sponsor-prize requirement confirmation + "From Scratch" git-log audit), T127 (2–4 min demo video, narration/no-TTS/no-speed-up rules — see `mem:global/...` if a demo-video memory exists in the auto-memory system, not here), T129 (final production deploy check + 3-min demo run-through).

## How to re-check this

`grep -n '^\s*- \[ \]' specs/001-rights-runtime-mvp/tasks.md` lists exactly what's still open, with full task text (mostly in Japanese per `.claude/rules/speckit-language.md`). `grep -n '^## Phase' specs/001-rights-runtime-mvp/tasks.md` gives phase boundaries. Treat this memory as a pointer to go re-run that grep, not as a substitute for it once more than a session or two has passed.