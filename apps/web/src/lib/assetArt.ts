/**
 * Deterministic decorative art for an asset card thumbnail (Market redesign, design review
 * 2026-09). There is no real preview image in AssetSummary - only `previewURI`, which points at
 * gateway-authorized content, not a public thumbnail - so this derives a stable gradient/pattern
 * from the assetId hash instead of claiming a specific appearance for the dataset. Same assetId
 * always renders the same art (useful for recognizing a listing across reloads).
 */
export type AssetArtSpec = {
  hueA: number;
  hueB: number;
  seed: number;
};

/** FNV-1a, good enough for a stable, well-distributed art seed (not cryptographic). */
function hashHex(hex: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < hex.length; i++) {
    h ^= hex.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function assetArtSpec(assetId: string): AssetArtSpec {
  const h = hashHex(assetId.toLowerCase());
  const hueA = h % 360;
  const hueB = (hueA + 40 + ((h >>> 8) % 60)) % 360;
  return { hueA, hueB, seed: h };
}
