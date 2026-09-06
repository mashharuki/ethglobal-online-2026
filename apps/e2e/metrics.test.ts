import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkThresholds,
  loadSamples,
  percentile,
  readRecordedRunId,
  recordMetric,
  recordRunId,
  renderReport,
  samplesOfRun,
  summarize,
} from "./metrics";

const at = "";

describe("metrics (T117)", () => {
  afterEach(() => {
    delete process.env.E2E_RUN_ID;
  });

  it("should compute nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });

  it("should summarize per metric and judge quickstart thresholds, BLOCKED when empty", () => {
    const samples = [
      { metric: "owner_access_ms", ms: 4000, at, runId: "r1" },
      { metric: "owner_access_ms", ms: 9000, at, runId: "r1" },
      { metric: "replay_reject_ms", ms: 1200, at, runId: "r1" },
    ];
    const summaries = summarize(samples);
    expect(summaries.find((s) => s.metric === "owner_access_ms")).toMatchObject(
      {
        n: 2,
        p50: 4000,
        p95: 9000,
        max: 9000,
      },
    );
    const verdicts = checkThresholds(summaries);
    expect(
      verdicts.find(
        (v) => v.metric === "owner_access_ms" && v.check.startsWith("p50"),
      )?.ok,
    ).toBe(true);
    expect(verdicts.find((v) => v.metric === "replay_reject_ms")?.ok).toBe(
      true,
    );
    // no samples is never a pass
    expect(verdicts.find((v) => v.metric === "buyer_access_ms")).toMatchObject({
      ok: false,
      detail: "BLOCKED: no samples recorded",
    });
    expect(renderReport(verdicts, "r1")).toContain(
      "FAIL buyer_access_ms samples",
    );
    expect(renderReport(verdicts, "r1")).toContain("run: r1");
    // a violation fails
    expect(
      checkThresholds(
        summarize([{ metric: "replay_reject_ms", ms: 5000, at, runId: "r1" }]),
        {
          replay_reject_ms: { max: 3000 },
        },
      ),
    ).toEqual([
      {
        metric: "replay_reject_ms",
        check: "max < 3000ms",
        ok: false,
        detail: "max=5000ms over 1 samples",
      },
    ]);
  });

  it("should record samples under the current run id and read only one run back", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "e2e-metrics-")),
      "metrics.json",
    );
    process.env.E2E_RUN_ID = "run-old";
    recordMetric("owner_access_ms", 1234.6, "first run", path);
    process.env.E2E_RUN_ID = "run-new";
    recordMetric("replay_reject_ms", 800, undefined, path);
    const all = loadSamples(path);
    expect(all).toMatchObject([
      {
        metric: "owner_access_ms",
        ms: 1235,
        runId: "run-old",
        note: "first run",
      },
      { metric: "replay_reject_ms", ms: 800, runId: "run-new" },
    ]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(2);

    // one run only: the old owner sample must not leak into the new run's verdicts
    expect(samplesOfRun(all, "run-new").map((s) => s.metric)).toEqual([
      "replay_reject_ms",
    ]);
    const verdicts = checkThresholds(summarize(samplesOfRun(all, "run-new")));
    expect(verdicts.find((v) => v.metric === "owner_access_ms")?.detail).toBe(
      "BLOCKED: no samples recorded",
    );
    // a run that skipped every spec recorded nothing -> every metric BLOCKED, nothing borrowed
    const skipped = checkThresholds(
      summarize(samplesOfRun(all, "run-skipped")),
    );
    expect(skipped.every((v) => !v.ok && v.detail.startsWith("BLOCKED"))).toBe(
      true,
    );
  });

  it("should persist the run id independently of samples so a skipped run is still the current run", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "e2e-run-")),
      "nested",
      "e2e-run-id",
    );
    expect(readRecordedRunId(path)).toBeUndefined();
    recordRunId("run-2026", path);
    expect(readRecordedRunId(path)).toBe("run-2026");
    expect(readFileSync(path, "utf8")).toBe("run-2026\n");
  });
});
