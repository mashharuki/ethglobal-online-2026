import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE_VERSION } from "../src/index";

describe("@truenft/shared", () => {
  it("should expose a package version", () => {
    expect(SHARED_PACKAGE_VERSION).toBe("0.1.0");
  });
});
