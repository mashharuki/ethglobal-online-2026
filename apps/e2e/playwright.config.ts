import { defineConfig } from "@playwright/test";

/**
 * Browser E2E runs against a deployed web + gateway (tasks.md Phase 10).
 * Without WEB_URL / GATEWAY_URL the suite is filtered out and a visible notice is
 * printed so a green run is never mistaken for a verified deployment. Set
 * E2E_REQUIRED=1 (CI jobs that must verify the live system) to fail instead of skipping.
 */
// one id per Playwright run, inherited by the worker processes: metrics.ts reports one run only
process.env.E2E_RUN_ID ??= `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;

const webUrl = process.env.WEB_URL ?? "";
const gatewayUrl = process.env.GATEWAY_URL ?? "";
const hasTargets = webUrl !== "" && gatewayUrl !== "";

if (!hasTargets) {
  const message =
    "[e2e] WEB_URL / GATEWAY_URL not set: browser E2E specs are SKIPPED (not verified).";
  if (process.env.E2E_REQUIRED === "1") {
    throw new Error(`${message} E2E_REQUIRED=1 so this is a failure.`);
  }
  console.warn(message);
}

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
