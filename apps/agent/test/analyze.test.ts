import { describe, expect, it } from "vitest";
import {
  ANSWER_TOOL,
  DATASET_CHAR_LIMIT,
  extractAnswer,
  truncateDataset,
  ungroundedEvidence,
} from "../src/analyze";

describe("analyze (T120)", () => {
  it("should cut oversized datasets and say so", () => {
    expect(truncateDataset("abc")).toEqual({
      content: "abc",
      truncated: false,
    });
    const big = "x".repeat(DATASET_CHAR_LIMIT + 1);
    expect(truncateDataset(big)).toMatchObject({ truncated: true });
    expect(truncateDataset(big).content).toHaveLength(DATASET_CHAR_LIMIT);
  });

  it("should read the forced `answer` tool call and normalise its fields", () => {
    const analysis = extractAnswer({
      content: [
        { type: "text" },
        {
          type: "tool_use",
          name: ANSWER_TOOL.name,
          input: {
            answer: "EMEA grew most: 12.5%",
            evidence: [
              { label: "emea growth", value: "12.5" },
              { label: "bad" },
            ],
            confidence: "weird",
          },
        },
      ],
    });
    expect(analysis).toEqual({
      answer: "EMEA grew most: 12.5%",
      evidence: [{ label: "emea growth", value: "12.5" }],
      confidence: "low",
    });
  });

  it("should refuse a reply without an answer", () => {
    expect(() => extractAnswer({ content: [{ type: "text" }] })).toThrow(
      /no `answer` tool call/,
    );
    expect(() =>
      extractAnswer({
        content: [{ type: "tool_use", name: "answer", input: { answer: " " } }],
      }),
    ).toThrow(/no answer text/);
  });

  it("should flag evidence that is not in the dataset", () => {
    const dataset = "region,growth\\nemea,12.5\\napac,3.0\\n";
    const analysis = {
      answer: "x",
      evidence: [
        { label: "emea", value: "12.5" },
        { label: "made up", value: "99.9" },
      ],
      confidence: "high" as const,
    };
    expect(ungroundedEvidence(analysis, dataset)).toEqual([
      { label: "made up", value: "99.9" },
    ]);
  });
});
