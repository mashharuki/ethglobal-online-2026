import { describe, expect, it } from "vitest";
import {
  createApi,
  listAssets,
  ownerChallenge,
  toGatewayError,
} from "./client";

describe("gateway client (T105)", () => {
  it("should map both error envelopes to GatewayError", () => {
    expect(
      toGatewayError(403, { code: "NOT_AUTHORIZED", message: "no" }),
    ).toMatchObject({
      status: 403,
      code: "NOT_AUTHORIZED",
      message: "no",
    });
    expect(
      toGatewayError(400, { error: "bad_request", message: "x" }),
    ).toMatchObject({
      code: "bad_request",
    });
    expect(toGatewayError(502, "gateway down")).toMatchObject({
      code: "HTTP_502",
    });
  });

  it("should type requests against the openapi paths and throw on non-2xx", async () => {
    const api = createApi("http://gateway.test", async (input, init) => {
      const req = new Request(input, init);
      const url = req.url;
      if (url === "http://gateway.test/assets") return Response.json([]);
      if (url.endsWith("/owner/challenge")) {
        expect(await req.json()).toEqual({
          assetId: `0x${"a5".repeat(32)}`,
          wallet: "0x1111111111111111111111111111111111111111",
        });
        return Response.json(
          { code: "RATE_LIMITED", message: "slow down" },
          { status: 429 },
        );
      }
      return new Response("nope", { status: 500 });
    });
    expect(await listAssets(api)).toEqual([]);
    await expect(
      ownerChallenge(api, {
        assetId: `0x${"a5".repeat(32)}`,
        wallet: "0x1111111111111111111111111111111111111111",
      }),
    ).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
  });
});
