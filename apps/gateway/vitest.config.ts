import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Runs the test suite inside workerd (Miniflare) so Durable Objects, KV and
 * Hyperdrive bindings behave as in production. Chain-dependent specs skip
 * unless contract addresses are configured (reported as skipped, never as pass);
 * REQUIRE_LIVE_CHAIN=1 turns that skip into a failure for gated CI runs, and
 * PROBE_DB_QUERY=1 enables the Postgres round-trip in the T019 probe.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          REQUIRE_LIVE_CHAIN: process.env.REQUIRE_LIVE_CHAIN ?? "",
          PROBE_DB_QUERY: process.env.PROBE_DB_QUERY ?? "",
        },
      },
    }),
  ],
  test: {
    name: "gateway",
    include: ["test/**/*.spec.ts"],
  },
});
