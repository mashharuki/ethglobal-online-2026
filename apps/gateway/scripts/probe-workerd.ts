// tasks.md T019 (research.md R-7 day1 probe): prove that viem, the postgres driver, Workers KV,
// Hyperdrive bindings and the Durable Object classes load and respond inside workerd.
// Runs test/probe.spec.ts under @cloudflare/vitest-pool-workers and writes a machine-readable
// summary to out/probe-workerd.json for the research.md probe table.
//   pnpm --filter gateway probe:workerd
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type VitestJson = {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  testResults: Array<{
    assertionResults: Array<{ fullName: string; status: string }>;
  }>;
};

const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(gatewayDir, "out");
mkdirSync(outDir, { recursive: true });
const rawFile = resolve(outDir, "probe-workerd.vitest.json");

let exitCode = 0;
try {
  execFileSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "test/probe.spec.ts",
      "--reporter=json",
      `--outputFile=${rawFile}`,
    ],
    { cwd: gatewayDir, stdio: "inherit" },
  );
} catch (error) {
  exitCode =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: number }).status)
      : 1;
}

const raw = JSON.parse(readFileSync(rawFile, "utf8")) as VitestJson;
const wranglerVersion = (
  JSON.parse(
    readFileSync(
      resolve(gatewayDir, "node_modules/wrangler/package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;
const summary = {
  probedAt: new Date().toISOString(),
  wranglerVersion,
  total: raw.numTotalTests,
  passed: raw.numPassedTests,
  failed: raw.numFailedTests,
  checks: raw.testResults.flatMap((file) =>
    file.assertionResults.map((a) => ({ name: a.fullName, status: a.status })),
  ),
  verdict:
    raw.numFailedTests === 0 && raw.numTotalTests > 0
      ? "workerd runtime OK for viem / postgres / KV / Hyperdrive binding / DO"
      : "FAILED - see checks",
};
const summaryFile = resolve(outDir, "probe-workerd.json");
writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`wrote ${summaryFile}: ${summary.verdict}`);
process.exit(exitCode);
