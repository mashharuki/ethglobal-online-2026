// tasks.md T019 (research.md R-7 day1 probe): prove that viem, the postgres driver, Workers KV,
// Hyperdrive bindings and the Durable Object classes load and respond inside workerd.
// Runs test/probe.spec.ts under @cloudflare/vitest-pool-workers and writes a machine-readable
// summary to out/probe-workerd.json for the research.md probe table.
//   pnpm --filter gateway probe:workerd                 (7 checks; the DB query is skipped)
//   PROBE_DB_QUERY=1 pnpm --filter gateway probe:workerd (8 checks; needs the Hyperdrive
//                                                        localConnectionString Postgres up)
// Verdict is OK only when the runner exited 0 AND every expected check passed - a stale
// report, a killed runner or a skipped check can never produce OK.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type VitestJson = {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: Array<{
    assertionResults: Array<{ fullName: string; status: string }>;
  }>;
};

const probeDbQuery = process.env.PROBE_DB_QUERY === "1";
const EXPECTED_CHECKS = probeDbQuery ? 8 : 7;

const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(gatewayDir, "out");
mkdirSync(outDir, { recursive: true });
const rawFile = resolve(outDir, "probe-workerd.vitest.json");
rmSync(rawFile, { force: true }); // never read a previous run's report

let runnerExit = 1;
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
    {
      cwd: gatewayDir,
      stdio: "inherit",
      env: { ...process.env, PROBE_DB_QUERY: probeDbQuery ? "1" : "" },
    },
  );
  runnerExit = 0;
} catch (error) {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status: number | null }).status
      : null;
  runnerExit = typeof status === "number" && status !== 0 ? status : 1;
}

let raw: VitestJson | undefined;
try {
  raw = JSON.parse(readFileSync(rawFile, "utf8")) as VitestJson;
} catch {
  raw = undefined;
}
const wranglerVersion = (
  JSON.parse(
    readFileSync(
      resolve(gatewayDir, "node_modules/wrangler/package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;

const passed = raw?.numPassedTests ?? 0;
const failed = raw?.numFailedTests ?? 0;
const skipped = raw?.numPendingTests ?? 0;
const ok =
  runnerExit === 0 &&
  raw !== undefined &&
  failed === 0 &&
  passed === EXPECTED_CHECKS;
const summary = {
  probedAt: new Date().toISOString(),
  wranglerVersion,
  runnerExit,
  expectedChecks: EXPECTED_CHECKS,
  passed,
  failed,
  skipped,
  checks:
    raw?.testResults.flatMap((file) =>
      file.assertionResults.map((a) => ({
        name: a.fullName,
        status: a.status,
      })),
    ) ?? [],
  notProbed: probeDbQuery
    ? []
    : ["Postgres query through the Hyperdrive binding (set PROBE_DB_QUERY=1)"],
  verdict: ok
    ? "workerd runtime OK for viem / postgres driver / KV / Hyperdrive binding / DO / Web Crypto"
    : `FAILED (runnerExit=${runnerExit}, passed=${passed}/${EXPECTED_CHECKS}, failed=${failed})`,
};
const summaryFile = resolve(outDir, "probe-workerd.json");
writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`wrote ${summaryFile}: ${summary.verdict}`);
process.exit(ok ? 0 : 1);
