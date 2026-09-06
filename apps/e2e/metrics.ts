import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Latency evidence for SC-001 / SC-002 / SC-003 / SC-005 (tasks.md T117, quickstart §1).
 * Specs append samples with `recordMetric`; `summarize` folds them into p50 / p95 per metric
 * and `checkThresholds` turns quickstart's limits into a pass / fail list. `pnpm --filter e2e
 * metrics` prints the table and exits non-zero on a violation.
 */
export type Sample = { metric: string; ms: number; at: string; note?: string };

export type Threshold = { p50?: number; p95?: number; max?: number };

/** quickstart.md §1: the numbers the demo contract promises (milliseconds) */
export const THRESHOLDS: Record<string, Threshold> = {
  owner_access_ms: { p50: 8_000, p95: 15_000 }, // SC-001
  buyer_access_ms: { p50: 20_000, p95: 40_000 }, // SC-002
  transfer_revoke_ms: { max: 10_000 }, // SC-003
  replay_reject_ms: { max: 3_000 }, // SC-005 (app-layer rejections, not the on-chain settle)
};

export const METRICS_PATH = resolve(import.meta.dirname, "metrics.json");

export function loadSamples(path = METRICS_PATH): Sample[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return Array.isArray(parsed) ? (parsed as Sample[]) : [];
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

export function renderReport(verdicts: Verdict[]): string {
  return verdicts
    .map(
      (v) => `${v.ok ? "PASS" : "FAIL"} ${v.metric} ${v.check} (${v.detail})`,
    )
    .join("\n");
}

const isDirectRun = process.argv[1]?.endsWith("metrics.ts") ?? false;
if (isDirectRun) {
  const verdicts = checkThresholds(summarize(loadSamples()));
  console.log(renderReport(verdicts));
  process.exit(verdicts.every((v) => v.ok) ? 0 : 1);
}
