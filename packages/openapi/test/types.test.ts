import { describe, expect, it } from "vitest";
import type { ErrorBody, JsonResponse } from "../src/index";

describe("@truenft/openapi generated types", () => {
  it("should type the /healthz response from openapi.yaml", () => {
    const health: JsonResponse<"/healthz", "get"> = { ok: true, chainId: 296 };
    expect(health.chainId).toBe(296);
  });

  it("should constrain error bodies to the ErrorCode enum", () => {
    const body: ErrorBody = {
      code: "OWNER_EPOCH_MISMATCH",
      message: "This session predates an NFT transfer.",
    };
    expect(body.code).toBe("OWNER_EPOCH_MISMATCH");
  });
});
