import { defineConfig } from "@playwright/test";

/**
 * Browser E2E runs against a deployed web + gateway (tasks.md Phase 10).
 * Without GATEWAY_URL / WEB_URL the suite is skipped explicitly (reported as such, never as pass).
 */
const webUrl = process.env.WEB_URL ?? "";
const gatewayUrl = process.env.GATEWAY_URL ?? "";
const hasTargets = webUrl !== "" && gatewayUrl !== "";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.e2e\.ts/,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
  use: {
    baseURL: hasTargets ? webUrl : undefined,
    trace: "retain-on-failure",
  },
  grep: hasTargets ? undefined : /$^/,
});
