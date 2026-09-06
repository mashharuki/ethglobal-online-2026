import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkThresholds,
  loadSamples,
  percentile,
  recordMetric,
  renderReport,
  summarize,
} from "./metrics";

describe("metrics (T117)", () => {
  it("should compute nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });

  it("should summarize per metric and judge quickstart thresholds, BLOCKED when empty", () => {
    const samples = [
      { metric: "owner_access_ms", ms: 4000, at: "" },
      { metric: "owner_access_ms", ms: 9000, at: "" },
      { metric: "replay_reject_ms", ms: 1200, at: "" },
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
    expect(renderReport(verdicts)).toContain("FAIL buyer_access_ms samples");
    // a violation fails
    expect(
      checkThresholds(
        summarize([{ metric: "replay_reject_ms", ms: 5000, at: "" }]),
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

  it("should append samples to the metrics file", () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-"));
    const path = join(dir, "metrics.json");
    recordMetric("owner_access_ms", 1234.6, "spec", path);
    recordMetric("owner_access_ms", 2000, undefined, path);
    expect(loadSamples(path).map((s) => s.ms)).toEqual([1235, 2000]);
    expect(JSON.parse(readFileSync(path, "utf8"))[0].note).toBe("spec");
  });
});
