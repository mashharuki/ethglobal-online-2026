import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ErrorCode } from "@truenft/shared";
import { describe, expect, it } from "vitest";
import { syncedYaml } from "../scripts/sync-error-codes";

const yamlPath = resolve(import.meta.dirname, "../openapi.yaml");

describe("openapi.yaml ErrorCode enum", () => {
  const source = readFileSync(yamlPath, "utf8");

  it("should list exactly the codes of @truenft/shared ErrorCode, in order", () => {
    expect(syncedYaml(source, Object.values(ErrorCode))).toBe(source);
  });

  it("should detect drift (positive control)", () => {
    const drifted = syncedYaml(source, [
      ...Object.values(ErrorCode),
      "SOMETHING_NEW",
    ]);
    expect(drifted).not.toBe(source);
    expect(drifted).toContain("- SOMETHING_NEW");
  });
});
