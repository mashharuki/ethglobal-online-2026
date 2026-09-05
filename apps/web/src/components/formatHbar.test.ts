import { describe, expect, it } from "vitest";

import { formatHbar } from "./formatHbar";

describe("formatHbar", () => {
  it("converts tinybars to HBAR with up to 8 decimals", () => {
    expect(formatHbar(100_000_000n)).toBe("1 ℏ");
    expect(formatHbar(150_000_000n)).toBe("1.5 ℏ");
    expect(formatHbar(1000n)).toBe("0.00001 ℏ");
  });

  it("formats zero", () => {
    expect(formatHbar(0n)).toBe("0 ℏ");
  });
});
