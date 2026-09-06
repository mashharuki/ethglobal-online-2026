import { describe, expect, it } from "vitest";
import {
  compareDecimal,
  DEFAULT_CHECK,
  expectedExtreme,
  parseCheck,
  parseCsv,
  parseTable,
  questionFor,
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
const EXPECTED = { label: "Shinjuku", value: "2401" };

describe("verify (SC-007 answer gate)", () => {
  it("should tabulate the seed json and csv formats and find the extreme row", () => {
    expect(
      expectedExtreme(parseTable("json", JSON_DATASET), DEFAULT_CHECK),
    ).toEqual(EXPECTED);
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

  it("should accept an answer whose result, exact citation and opening all state the row", () => {
    const verdict = verifyAnalysis(
      {
        answer:
          "Shinjuku: 2401 - the highest single-row visitors, on 2026-08-03.",
        evidence: [{ label: "Shinjuku", value: "2401" }],
        result: EXPECTED,
        confidence: "high",
      },
      dataset,
      DEFAULT_CHECK,
    );
    expect(verdict).toEqual({
      ok: true,
      problems: [],
      expected: EXPECTED,
      statement: "Shinjuku: 2401 (highest visitors per district)",
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
    expect(
      verifyAnalysis(
        { answer: "x", evidence: [], confidence: "low" },
        dataset,
        undefined,
      ).ok,
    ).toBe(false);
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
    // real citations, wrong conclusion
    const wrong = verifyAnalysis(
      {
        answer: "Shibuya: 1842 had the highest visitors.",
        evidence: [{ label: "Shibuya", value: "1842" }],
        result: { label: "Shibuya", value: "1842" },
        confidence: "high",
      },
      dataset,
      DEFAULT_CHECK,
    );
    expect(wrong.problems).toEqual([
      "result Shibuya=1842 is not the max row Shinjuku=2401",
      "no citation with label Shinjuku and value 2401",
      'answer does not open with "Shinjuku: 2401"',
    ]);
  });

  it("should reject the right words in the wrong places", () => {
    // correct result and citation, but the text denies the conclusion
    const denial = verifyAnalysis(
      {
        answer: "Shinjuku (2401) is not the maximum; Shibuya is.",
        evidence: [{ label: "Shinjuku", value: "2401" }],
        result: EXPECTED,
        confidence: "high",
      },
      dataset,
      DEFAULT_CHECK,
    );
    expect(denial.problems).toEqual([
      'answer does not open with "Shinjuku: 2401"',
    ]);
    // the value attributed to another district, and a label that merely contains the winner
    const misattributed = verifyAnalysis(
      {
        answer: "Shinjuku: 2401",
        evidence: [
          { label: "Shibuya", value: "2401" },
          { label: "West Shinjuku", value: "2401" },
        ],
        result: EXPECTED,
        confidence: "high",
      },
      dataset,
      DEFAULT_CHECK,
    );
    expect(misattributed.problems).toEqual([
      "citation Shibuya=2401 is not a row of the dataset",
      "citation West Shinjuku=2401 is not a row of the dataset",
      "no citation with label Shinjuku and value 2401",
    ]);
    // the winning row cited correctly, plus a false extra attribution of the same value
    expect(
      verifyAnalysis(
        {
          answer: "Shinjuku: 2401",
          evidence: [
            { label: "Shinjuku", value: "2401" },
            { label: "Shibuya", value: "2401" },
          ],
          result: EXPECTED,
          confidence: "high",
        },
        dataset,
        DEFAULT_CHECK,
      ).problems,
    ).toEqual(["citation Shibuya=2401 is not a row of the dataset"]);
    // the opening as a prefix of a longer number, and a negation after a correct opening
    for (const answer of ["Shinjuku: 24010", "Shinjuku: 2401.5 visitors"]) {
      expect(
        verifyAnalysis(
          {
            answer,
            evidence: [{ label: "Shinjuku", value: "2401" }],
            result: EXPECTED,
            confidence: "high",
          },
          dataset,
          DEFAULT_CHECK,
        ).problems,
      ).toEqual(['answer does not open with "Shinjuku: 2401"']);
    }
    expect(
      verifyAnalysis(
        {
          answer: "Shinjuku: 2401 is not the maximum; Shibuya is.",
          evidence: [{ label: "Shinjuku", value: "2401" }],
          result: EXPECTED,
          confidence: "high",
        },
        dataset,
        DEFAULT_CHECK,
      ).problems,
    ).toEqual([
      "answer contains a negation; the verified conclusion is the statement",
    ]);
    // no structured result at all
    expect(
      verifyAnalysis(
        {
          answer: "Shinjuku: 2401",
          evidence: [{ label: "Shinjuku", value: "2401" }],
          confidence: "high",
        },
        dataset,
        DEFAULT_CHECK,
      ).problems,
    ).toEqual(["no structured result"]);
  });

  it("should parse RFC 4180 csv strictly", () => {
    expect(
      parseCsv('a,b\n"West, End",10\n"multi\nline","say ""hi"""\n'),
    ).toEqual([
      ["a", "b"],
      ["West, End", "10"],
      ["multi\nline", 'say "hi"'],
    ]);
    expect(parseCsv("a,b\r\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(() => parseCsv('a\n1"0"\n')).toThrow(/misplaced quote/);
    expect(() => parseCsv('a\n"1"0\n')).toThrow(/text after closing quote/);
    expect(() => parseCsv('a\n"1\n')).toThrow(/unterminated quote/);
    const quoted = 'district,visitors\n"West, End",10\nEast,5\n';
    expect(expectedExtreme(parseTable("csv", quoted), DEFAULT_CHECK)).toEqual({
      label: "West, End",
      value: "10",
    });
    expect(() => parseTable("csv", "district,visitors\nEast\n")).toThrow(
      /row 0 has 1 cells/,
    );
  });

  it("should compare values exactly and refuse non-decimal or unlabeled rows", () => {
    expect(compareDecimal("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareDecimal("1.50", "1.5")).toBe(0);
    expect(compareDecimal("-0.1", "0")).toBe(-1);
    expect(() => compareDecimal("1e3", "1")).toThrow(/not a plain decimal/);
    const huge = "district,visitors\nA,9007199254740992\nB,9007199254740993\n";
    expect(expectedExtreme(parseTable("csv", huge), DEFAULT_CHECK)).toEqual({
      label: "B",
      value: "9007199254740993",
    });
    expect(() =>
      expectedExtreme(
        parseTable("csv", "district,visitors\nEast,n/a\n"),
        DEFAULT_CHECK,
      ),
    ).toThrow(/not a plain decimal/);
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
    expect(questionFor(DEFAULT_CHECK)).toContain(
      'begin `answer` with "<district>: <visitors>"',
    );
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
