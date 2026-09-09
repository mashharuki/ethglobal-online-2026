import { describe, expect, it } from "vitest";
import { fetchConsentDetails, submitConsentDecision } from "./client";

describe("oauth/client (Phase 9, GET/POST /oauth/consent)", () => {
  it("should fetch and shape consent details, sending the Privy Bearer token", async () => {
    let capturedAuth: string | null = null;
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedAuth = new Headers(init?.headers).get("Authorization");
      return Response.json({
        client_id: "client-1",
        client_name: "Claude Code",
        scope: "assets:read access:buy",
        resource: "https://gateway.example/mcp",
        expires_at: "2026-09-09T12:10:00.000Z",
      });
    }) as typeof fetch;

    const details = await fetchConsentDetails(
      "http://gateway.test",
      "privy-token-abc",
      "req-1",
      fetchImpl,
    );

    expect(capturedUrl).toBe(
      "http://gateway.test/oauth/consent?request_id=req-1",
    );
    expect(capturedAuth).toBe("Bearer privy-token-abc");
    expect(details).toEqual({
      clientId: "client-1",
      clientName: "Claude Code",
      scope: "assets:read access:buy",
      resource: "https://gateway.example/mcp",
      expiresAt: "2026-09-09T12:10:00.000Z",
    });
  });

  it("should throw GatewayError on a non-2xx response", async () => {
    const fetchImpl = (async () =>
      Response.json(
        { code: "CONSENT_REQUEST_INVALID", message: "expired" },
        { status: 400 },
      )) as typeof fetch;

    await expect(
      fetchConsentDetails(
        "http://gateway.test",
        "privy-token-abc",
        "req-1",
        fetchImpl,
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "CONSENT_REQUEST_INVALID",
    });
  });

  it("should POST the decision as JSON and return the redirect_uri", async () => {
    let capturedBody: unknown;
    const fetchImpl = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedBody = JSON.parse(init?.body as string);
      return Response.json({
        redirect_uri: "https://client.example/cb?code=abc&state=xyz",
      });
    }) as typeof fetch;

    const result = await submitConsentDecision(
      "http://gateway.test",
      "privy-token-abc",
      "req-1",
      "allow",
      fetchImpl,
    );

    expect(capturedBody).toEqual({ request_id: "req-1", decision: "allow" });
    expect(result).toEqual({
      redirectUri: "https://client.example/cb?code=abc&state=xyz",
    });
  });

  it("should throw GatewayError when the decision POST fails", async () => {
    const fetchImpl = (async () =>
      Response.json(
        { code: "AUTH_TOKEN_INVALID", message: "bad" },
        { status: 401 },
      )) as typeof fetch;

    await expect(
      submitConsentDecision(
        "http://gateway.test",
        "expired-token",
        "req-1",
        "deny",
        fetchImpl,
      ),
    ).rejects.toMatchObject({ status: 401, code: "AUTH_TOKEN_INVALID" });
  });
});
