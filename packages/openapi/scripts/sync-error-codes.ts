import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ErrorCode } from "@truenft/shared";

/**
 * Rewrites the `ErrorCode` enum block in openapi.yaml from packages/shared/src/errors.ts
 * (the canonical list). Run with `pnpm --filter @truenft/openapi sync-errors`; `--check`
 * exits 1 if the file is out of date (used by CI / the sync test).
 */
const yamlPath = resolve(import.meta.dirname, "../openapi.yaml");
const START = "    # sync-error-codes:start";
const END = "    # sync-error-codes:end";

export function renderErrorCodeBlock(codes: readonly string[]): string {
  return [
    `${START} (generated from packages/shared/src/errors.ts - do not edit by hand)`,
    "    ErrorCode:",
    "      type: string",
    "      description: |",
    "        Stable public contract. The canonical list lives in `packages/shared/src/errors.ts`;",
    "        this enum only mirrors it (T039 verifies the two stay identical). Do not rename values.",
    "      enum:",
    ...codes.map((code) => `        - ${code}`),
    END,
  ].join("\n");
}

export function syncedYaml(source: string, codes: readonly string[]): string {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("sync-error-codes markers not found in openapi.yaml");
  }
  return (
    source.slice(0, start) +
    renderErrorCodeBlock(codes) +
    source.slice(end + END.length)
  );
}

const isDirectRun = process.argv[1]?.endsWith("sync-error-codes.ts") ?? false;
if (isDirectRun) {
  const current = readFileSync(yamlPath, "utf8");
  const next = syncedYaml(current, Object.values(ErrorCode));
  if (process.argv.includes("--check")) {
    if (current !== next) {
      console.error(
        "openapi.yaml ErrorCode enum is out of sync with @truenft/shared (run sync-errors)",
      );
      process.exit(1);
    }
    console.log("openapi.yaml ErrorCode enum is in sync");
  } else {
    writeFileSync(yamlPath, next);
    console.log(
      `synced ${Object.values(ErrorCode).length} error codes into ${yamlPath}`,
    );
  }
}
