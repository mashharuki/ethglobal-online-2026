/**
 * @truenft/openapi - generated types for the Access Gateway HTTP API.
 *
 * `src/types.ts` is generated from `openapi.yaml` by `pnpm --filter @truenft/openapi generate`
 * and is committed so consumers typecheck without a build step; CI regenerates it and fails on drift.
 */
import type { components, paths } from "./types";

export type { components, operations, paths } from "./types";

export type Schemas = components["schemas"];
export type ErrorBody = Schemas["Error"];
export type ErrorCodeValue = Schemas["ErrorCode"];

/** Response body type helper: `JsonResponse<"/healthz", "get">`. */
export type JsonResponse<
  P extends keyof paths,
  M extends keyof paths[P],
  S extends number = 200,
> = paths[P][M] extends {
  responses: Record<S, { content: { "application/json": infer B } }>;
}
  ? B
  : never;
