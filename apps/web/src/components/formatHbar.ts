const TINYBARS_PER_HBAR = 100_000_000n;

/** Formats a tinybar amount as a trimmed decimal HBAR string, e.g. "1.5 ℏ". */
export function formatHbar(tinybars: bigint): string {
  const negative = tinybars < 0n;
  const abs = negative ? -tinybars : tinybars;
  const whole = abs / TINYBARS_PER_HBAR;
  const frac = (abs % TINYBARS_PER_HBAR)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return frac.length > 0 ? `${sign}${whole}.${frac} ℏ` : `${sign}${whole} ℏ`;
}
