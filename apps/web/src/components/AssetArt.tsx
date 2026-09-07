import { assetArtSpec } from "../lib/assetArt";

/** Deterministic gradient art for an asset card - see lib/assetArt.ts for why. */
export default function AssetArt(props: { assetId: string }) {
  const { hueA, hueB, seed } = assetArtSpec(props.assetId);
  const gradId = `asset-art-${seed}`;
  const angle = 40 + (seed % 90);
  return (
    <svg
      viewBox="0 0 400 220"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={gradId}
          gradientTransform={`rotate(${angle} 0.5 0.5)`}
        >
          <stop offset="0%" stopColor={`hsl(${hueA} 70% 22%)`} />
          <stop offset="55%" stopColor={`hsl(${hueB} 65% 34%)`} />
          <stop offset="100%" stopColor={`hsl(${hueA} 55% 14%)`} />
        </linearGradient>
      </defs>
      <rect width="400" height="220" fill={`url(#${gradId})`} />
      <circle
        cx={60 + (seed % 280)}
        cy={40 + ((seed >>> 5) % 140)}
        r={70}
        fill={`hsl(${hueB} 80% 60%)`}
        opacity="0.18"
      />
      <circle
        cx={340 - (seed % 260)}
        cy={170 - ((seed >>> 9) % 120)}
        r={44}
        fill={`hsl(${hueA} 80% 70%)`}
        opacity="0.14"
      />
    </svg>
  );
}
