import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Runs the test suite inside workerd (Miniflare) so Durable Objects, KV and
 * Hyperdrive bindings behave as in production. Chain-dependent specs skip
 * unless HEDERA_RPC_URL is set (reported as skipped, never as pass).
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
  test: {
    name: "gateway",
    include: ["test/**/*.spec.ts"],
  },
});
