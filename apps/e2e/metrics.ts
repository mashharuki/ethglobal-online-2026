import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Latency evidence for SC-001 / SC-002 / SC-003 / SC-005 (tasks.md T117, quickstart §1).
 * Specs append samples with `recordMetric`; every sample carries the `runId` of the Playwright
 * run that produced it. playwright.config.ts mints E2E_RUN_ID and persists it to
 * .e2e-run-id BEFORE any spec runs, so a run that skipped everything still leaves
 * its id behind and the report (which reads exactly one run: E2E_RUN_ID, else that file) finds
 * zero samples for it -> BLOCKED, never the previous run's pass. `pnpm --filter e2e metrics`
 * prints the table and exits non-zero on a violation or on a metric without samples.
 */
export type Sample = {
  metric: string;
  ms: number;
  at: string;
  runId: string;
  note?: string;
};

export type Threshold = { p50?: number; p95?: number; max?: number };

/** quickstart.md §1: the numbers the demo contract promises (milliseconds) */
export const THRESHOLDS: Record<string, Threshold> = {
  owner_access_ms: { p50: 8_000, p95: 15_000 }, // SC-001
  buyer_access_ms: { p50: 20_000, p95: 40_000 }, // SC-002
  transfer_revoke_ms: { max: 10_000 }, // SC-003
  replay_reject_ms: { max: 3_000 }, // SC-005: the slowest app-layer rejection of the burst
};

export const METRICS_PATH = resolve(import.meta.dirname, "metrics.json");
// NOT under test-results/: Playwright wipes that directory at the start of every run
export const RUN_ID_PATH = resolve(import.meta.dirname, ".e2e-run-id");

export function currentRunId(): string {
  return process.env.E2E_RUN_ID ?? "unset";
}

/** Written by playwright.config.ts at startup: the id of the most recent run, samples or not. */
export function recordRunId(runId: string, path = RUN_ID_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${runId}\n`);
}

export function readRecordedRunId(path = RUN_ID_PATH): string | undefined {
  if (!existsSync(path)) return undefined;
  const id = readFileSync(path, "utf8").trim();
  return id === "" ? undefined : id;
}

export function loadSamples(path = METRICS_PATH): Sample[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return Array.isArray(parsed) ? (parsed as Sample[]) : [];
}

/** Exactly the samples of `runId` - empty when that run recorded nothing. */
export function samplesOfRun(samples: Sample[], runId: string): Sample[] {
  return samples.filter((s) => s.runId === runId);
}

export function recordMetric(
  metric: string,
  ms: number,
  note?: string,
  path = METRICS_PATH,
): void {
  const samples = loadSamples(path);
  samples.push({
    metric,
    ms: Math.round(ms),
    at: new Date().toISOString(),
    runId: currentRunId(),
    note,
  });
  writeFileSync(path, `${JSON.stringify(samples, null, 2)}\n`);
}

/** nearest-rank percentile on a sorted copy (p in [0, 100]) */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

export type Summary = {
  metric: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
};

export function summarize(samples: Sample[]): Summary[] {
  const byMetric = new Map<string, number[]>();
  for (const s of samples) {
    if (!Number.isFinite(s.ms)) continue;
    byMetric.set(s.metric, [...(byMetric.get(s.metric) ?? []), s.ms]);
  }
  return [...byMetric.entries()]
    .map(([metric, values]) => ({
      metric,
      n: values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: Math.max(...values),
    }))
    .sort((a, b) => a.metric.localeCompare(b.metric));
}

export type Verdict = {
  metric: string;
  check: string;
  ok: boolean;
  detail: string;
};

/** One verdict per threshold. A metric without samples is BLOCKED (never a pass). */
export function checkThresholds(
  summaries: Summary[],
  thresholds: Record<string, Threshold> = THRESHOLDS,
): Verdict[] {
  const verdicts: Verdict[] = [];
  for (const [metric, limit] of Object.entries(thresholds)) {
    const summary = summaries.find((s) => s.metric === metric);
    if (summary === undefined) {
      verdicts.push({
        metric,
        check: "samples",
        ok: false,
        detail: "BLOCKED: no samples recorded",
      });
      continue;
    }
    for (const [key, bound] of Object.entries(limit) as Array<
      [keyof Threshold, number]
    >) {
      const value = summary[key];
      verdicts.push({
        metric,
        check: `${key} < ${bound}ms`,
        ok: value < bound,
        detail: `${key}=${value}ms over ${summary.n} samples`,
      });
    }
  }
  return verdicts;
}

export function renderReport(verdicts: Verdict[], runId?: string): string {
  const lines = verdicts.map(
    (v) => `${v.ok ? "PASS" : "FAIL"} ${v.metric} ${v.check} (${v.detail})`,
  );
  return [`run: ${runId ?? "(none recorded)"}`, ...lines].join("\n");
}

const isDirectRun = process.argv[1]?.endsWith("metrics.ts") ?? false;
if (isDirectRun) {
  const runId = process.env.E2E_RUN_ID ?? readRecordedRunId();
  if (runId === undefined) {
    console.log("BLOCKED: no Playwright run recorded (.e2e-run-id missing)");
    process.exit(1);
  }
  const verdicts = checkThresholds(
    summarize(samplesOfRun(loadSamples(), runId)),
  );
  console.log(renderReport(verdicts, runId));
  process.exit(verdicts.every((v) => v.ok) ? 0 : 1);
}
