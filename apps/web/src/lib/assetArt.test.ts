import { describe, expect, it } from "vitest";
import { assetArtSpec } from "./assetArt";

describe("assetArtSpec", () => {
  it("should return the same spec for the same assetId", () => {
    const id = "0xAB12A348ED39C57B621090F18D7485EC32B7F9E3";
    expect(assetArtSpec(id)).toEqual(assetArtSpec(id));
  });

  it("should be case-insensitive (assetIds are hex, casing is not meaningful)", () => {
    const lower = "0xab12a348ed39c57b621090f18d7485ec32b7f9e3";
    const upper = "0xAB12A348ED39C57B621090F18D7485EC32B7F9E3";
    expect(assetArtSpec(lower)).toEqual(assetArtSpec(upper));
  });

  it("should give visibly different assetIds different hues most of the time", () => {
    const ids = [
      "0x0000000000000000000000000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000000000000000000000000003",
      "0x0000000000000000000000000000000000000000000000000000000000004",
    ];
    const hues = ids.map((id) => assetArtSpec(id).hueA);
    expect(new Set(hues).size).toBeGreaterThan(1);
  });

  it("should keep hues within a valid 0-359 range", () => {
    for (let i = 0; i < 50; i++) {
      const { hueA, hueB } = assetArtSpec(
        `0x${i.toString(16).padStart(64, "0")}`,
      );
      expect(hueA).toBeGreaterThanOrEqual(0);
      expect(hueA).toBeLessThan(360);
      expect(hueB).toBeGreaterThanOrEqual(0);
      expect(hueB).toBeLessThan(360);
    }
  });
});
