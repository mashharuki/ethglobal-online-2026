import { describe, expect, it } from "vitest";
import { parseQuestion } from "../src/index";

describe("parseQuestion", () => {
  it("should return the value following --question", () => {
    expect(parseQuestion(["--question", "What is the median?"])).toBe(
      "What is the median?",
    );
  });

  it("should return undefined when --question is absent", () => {
    expect(parseQuestion(["--verbose"])).toBeUndefined();
  });
});
