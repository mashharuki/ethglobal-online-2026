import { defineConfig } from "vitest/config";

/**
 * Root Vitest config. Vitest 4 replaced `vitest.workspace.ts` with `test.projects`;
 * each workspace keeps its own `vitest.config.ts` (the gateway one uses
 * `@cloudflare/vitest-pool-workers`). `pnpm test` runs the per-package scripts via
 * Turborepo; this file lets `pnpm exec vitest run` from the root discover them too.
 */
export default defineConfig({
  test: {
    projects: [
      "packages/shared",
      "packages/openapi",
      "apps/gateway",
      "apps/web",
      "apps/agent",
      "apps/cdk",
    ],
  },
});
