import { describe, expect, it } from "vitest";
import { fetchCiAccessToken } from "../src/auth";

/** Records the request the fetch stub received, alongside a canned response. */
function stubFetch(
  body: unknown,
  init: { status?: number } = {},
): { fetch: typeof fetch; requests: Request[] } {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, requestInit) => {
    requests.push(new Request(input, requestInit));
    return Response.json(body, { status: init.status ?? 200 });
  };
  return { fetch: fetchImpl, requests };
}

describe("fetchCiAccessToken", () => {
  it("should POST a refresh_token grant with the /mcp resource and return the access token", async () => {
    const stub = stubFetch({
      access_token: "at-1",
      expires_in: 3600,
      scope: "assets:read access:buy",
    });
    const result = await fetchCiAccessToken({
      gatewayUrl: "https://gateway.test/",
      clientId: "client-1",
      refreshToken: "refresh-1",
      fetch: stub.fetch,
    });
    expect(result).toEqual({
      accessToken: "at-1",
      expiresIn: 3600,
      scope: "assets:read access:buy",
    });
    const request = stub.requests[0];
    expect(request?.url).toBe("https://gateway.test/oauth/token");
    expect(request?.method).toBe("POST");
    const body = await request?.text();
    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh-1");
    expect(params.get("client_id")).toBe("client-1");
    expect(params.get("resource")).toBe("https://gateway.test/mcp");
  });

  it("should throw with the server's error/error_description on a non-2xx response", async () => {
    const stub = stubFetch(
      { error: "invalid_grant", error_description: "refresh token revoked" },
      { status: 400 },
    );
    await expect(
      fetchCiAccessToken({
        gatewayUrl: "https://gateway.test",
        clientId: "client-1",
        refreshToken: "refresh-1",
        fetch: stub.fetch,
      }),
    ).rejects.toThrow(/400 invalid_grant: refresh token revoked/);
  });

  it("should throw a generic message when the error response has no JSON body", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("not json", { status: 500 });
    await expect(
      fetchCiAccessToken({
        gatewayUrl: "https://gateway.test",
        clientId: "client-1",
        refreshToken: "refresh-1",
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(/500 unknown_error/);
  });

  it("should reject a 2xx response missing a valid access_token", async () => {
    const stub = stubFetch({ expires_in: 3600, scope: "assets:read" });
    await expect(
      fetchCiAccessToken({
        gatewayUrl: "https://gateway.test",
        clientId: "client-1",
        refreshToken: "refresh-1",
        fetch: stub.fetch,
      }),
    ).rejects.toThrow(/missing a valid access_token/);
  });

  it("should reject a 2xx response missing a valid expires_in", async () => {
    const stub = stubFetch({
      access_token: "at-1",
      expires_in: 0,
      scope: "assets:read",
    });
    await expect(
      fetchCiAccessToken({
        gatewayUrl: "https://gateway.test",
        clientId: "client-1",
        refreshToken: "refresh-1",
        fetch: stub.fetch,
      }),
    ).rejects.toThrow(/missing a valid expires_in/);
  });

  it("should reject a 2xx response missing a valid scope", async () => {
    const stub = stubFetch({ access_token: "at-1", expires_in: 3600 });
    await expect(
      fetchCiAccessToken({
        gatewayUrl: "https://gateway.test",
        clientId: "client-1",
        refreshToken: "refresh-1",
        fetch: stub.fetch,
      }),
    ).rejects.toThrow(/missing a valid scope/);
  });
});
