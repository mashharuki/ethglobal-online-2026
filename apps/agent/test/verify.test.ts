import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHECK,
  expectedExtreme,
  parseCheck,
  parseTable,
  questionFor,
  splitCsvLine,
  verifyAnalysis,
} from "../src/verify";

/** the shape of the seeded demo dataset A (apps/contracts/scripts/seed-data/dataset-a.json) */
const JSON_DATASET = JSON.stringify({
  columns: ["date", "district", "visitors", "avgSpendJpy"],
  rows: [
    ["2026-08-01", "Shibuya", 1842, 1180],
    ["2026-08-01", "Shinjuku", 2110, 1090],
    ["2026-08-03", "Shinjuku", 2401, 1110],
    ["2026-08-03", "Nakameguro", 811, 1460],
  ],
});
const CSV_DATASET =
  "district,visitors\nShibuya,1842\nShinjuku,2401\nNakameguro,811\n";
const dataset = { format: "json", content: JSON_DATASET };

describe("verify (SC-007 answer gate)", () => {
  it("should tabulate the seed json and csv formats and find the extreme row", () => {
    expect(
      expectedExtreme(parseTable("json", JSON_DATASET), DEFAULT_CHECK),
    ).toEqual({
      label: "Shinjuku",
      value: "2401",
    });
    expect(
      expectedExtreme(parseTable("csv", CSV_DATASET), {
        ...DEFAULT_CHECK,
        op: "min",
      }),
    ).toEqual({
      label: "Nakameguro",
      value: "811",
    });
    expect(() => parseTable("text", "hello")).toThrow(/cannot tabulate/);
    expect(() =>
      expectedExtreme(parseTable("csv", CSV_DATASET), {
        ...DEFAULT_CHECK,
        valueColumn: "x",
      }),
    ).toThrow(/no district \/ x columns/);
  });

  it("should accept an answer whose structured result, bound citation and text all name the row", () => {
    const verdict = verifyAnalysis(
      {
        answer:
          "Shinjuku had the highest visitors in a single row: 2401 on 2026-08-03.",
        evidence: [{ label: "Shinjuku 2026-08-03 visitors", value: "2401" }],
        result: { label: "Shinjuku", value: "2401" },
        confidence: "high",
      },
      dataset,
      DEFAULT_CHECK,
    );
    expect(verdict).toEqual({
      ok: true,
      problems: [],
      expected: { label: "Shinjuku", value: "2401" },
    });
  });

  it("should reject empty citations, values not in the data, and a fabricated conclusion", () => {
    // empty citation: "" is a substring of everything, so it must be refused explicitly
    expect(
      verifyAnalysis(
        {
          answer: "Shinjuku 2401",
          evidence: [{ label: "", value: "" }],
          confidence: "high",
        },
        dataset,
        undefined,
      ).problems,
    ).toEqual(["empty citation"]);
    // no evidence at all
    expect(
      verifyAnalysis(
        { answer: "x", evidence: [], confidence: "low" },
        dataset,
        undefined,
      ).ok,
    ).toBe(false);
    // value not in the dataset
    expect(
      verifyAnalysis(
        {
          answer: "Shinjuku 2401",
          evidence: [{ label: "made up", value: "9999" }],
          confidence: "high",
        },
        dataset,
        undefined,
      ).problems,
    ).toEqual(['evidence "9999" not in the dataset']);
    // real citations, wrong conclusion: the deterministic check catches it
    const wrong = verifyAnalysis(
      {
        answer: "Shibuya had the highest visitors with 1842.",
        evidence: [{ label: "Shibuya", value: "1842" }],
        result: { label: "Shibuya", value: "1842" },
        confidence: "high",
      },
      dataset,
      DEFAULT_CHECK,
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.problems).toEqual([
      "result Shibuya=1842 is not the max row Shinjuku=2401",
      "no citation bound to Shinjuku=2401",
      "answer does not quote Shinjuku and 2401",
    ]);
    // the right words in the wrong places: text mentions the row but denies it, and the
    // citation attributes the value to another district
    const twisted = verifyAnalysis(
      {
        answer: "Shinjuku (2401) is not the maximum; Shibuya is.",
        evidence: [{ label: "Shibuya", value: "2401" }],
        result: { label: "Shibuya", value: "2401" },
        confidence: "high",
      },
      dataset,
      DEFAULT_CHECK,
    );
    expect(twisted.problems).toEqual([
      "result Shibuya=2401 is not the max row Shinjuku=2401",
      "no citation bound to Shinjuku=2401",
    ]);
    // no structured result at all
    expect(
      verifyAnalysis(
        {
          answer: "Shinjuku 2401",
          evidence: [{ label: "Shinjuku", value: "2401" }],
          confidence: "high",
        },
        dataset,
        DEFAULT_CHECK,
      ).problems,
    ).toEqual(["no structured result"]);
  });

  it("should parse quoted csv cells and refuse ragged, non-numeric or unlabeled rows", () => {
    expect(splitCsvLine('"West, End",10,"say ""hi"""')).toEqual([
      "West, End",
      "10",
      'say "hi"',
    ]);
    const quoted = 'district,visitors\n"West, End",10\nEast,5\n';
    expect(expectedExtreme(parseTable("csv", quoted), DEFAULT_CHECK)).toEqual({
      label: "West, End",
      value: "10",
    });
    expect(() => parseTable("csv", "district,visitors\nEast\n")).toThrow(
      /row 0 has 1 cells/,
    );
    expect(() =>
      expectedExtreme(
        parseTable("csv", "district,visitors\nEast,n/a\n"),
        DEFAULT_CHECK,
      ),
    ).toThrow(/not numeric/);
    expect(() =>
      expectedExtreme(
        parseTable(
          "json",
          JSON.stringify({
            columns: ["district", "visitors"],
            rows: [[null, 3]],
          }),
        ),
        DEFAULT_CHECK,
      ),
    ).toThrow(/empty district/);
    expect(() =>
      expectedExtreme(parseTable("csv", "district,visitors\n"), DEFAULT_CHECK),
    ).toThrow(/no rows/);
  });

  it("should derive the question from the check and parse AGENT_CHECK strictly", () => {
    expect(questionFor(DEFAULT_CHECK)).toContain("highest visitors");
    expect(parseCheck(undefined)).toEqual(DEFAULT_CHECK);
    expect(
      parseCheck('{"labelColumn":"a","valueColumn":"b","op":"min"}'),
    ).toEqual({
      labelColumn: "a",
      valueColumn: "b",
      op: "min",
    });
    expect(() => parseCheck('{"labelColumn":"a"}')).toThrow(/AGENT_CHECK/);
  });
});
