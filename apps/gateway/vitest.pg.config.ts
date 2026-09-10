import { defineConfig } from "vitest/config";

/**
 * Real-Postgres tests (specs/mcp-auth-remediation-plan.md Phase 11): separate from
 * vitest.node.config.ts's PGlite suite because these need an actual Postgres server
 * (DATABASE_URL_PG) to exercise genuine concurrent lock contention, which a single-connection
 * PGlite instance cannot. Locally, absent DATABASE_URL_PG, test/pg/helpers.ts skips with a
 * printed notice; in CI, REQUIRE_PG=1 turns that into a hard failure instead (see
 * .github/workflows/ci.yml's postgres-concurrency job).
 */
export default defineConfig({
  test: {
    name: "gateway-pg",
    include: ["test/pg/**/*.pg.test.ts"],
    environment: "node",
    hookTimeout: 30_000,
  },
});
