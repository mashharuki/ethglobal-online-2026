import { describe, expect, it } from "vitest";
import {
  isAllowedRedirectUriForRegistration,
  isRegisteredRedirectUri,
} from "../../src/oauth/redirectUri";

describe("isRegisteredRedirectUri", () => {
  const registered = [
    "https://client.example/callback",
    "http://127.0.0.1:8080/cb",
  ];

  it("should accept an exact match", () => {
    expect(isRegisteredRedirectUri(registered, registered[0] as string)).toBe(
      true,
    );
  });

  it("should reject a different path under the same registered origin", () => {
    expect(
      isRegisteredRedirectUri(registered, "https://client.example/callback2"),
    ).toBe(false);
  });

  it("should reject a query string appended to an otherwise-exact https: match", () => {
    expect(
      isRegisteredRedirectUri(
        registered,
        "https://client.example/callback?evil=1",
      ),
    ).toBe(false);
  });

  it("should reject a different host, even with the same path", () => {
    expect(
      isRegisteredRedirectUri(registered, "https://attacker.example/callback"),
    ).toBe(false);
  });

  it("should accept a registered loopback http: URI with a DIFFERENT port (RFC 8252 §7.3)", () => {
    expect(
      isRegisteredRedirectUri(registered, "http://127.0.0.1:54321/cb"),
    ).toBe(true);
  });

  it("should still reject a loopback URI with a different path even if the port matches", () => {
    expect(
      isRegisteredRedirectUri(registered, "http://127.0.0.1:8080/different"),
    ).toBe(false);
  });

  it("should still reject a loopback URI with a different query even if the port differs", () => {
    expect(
      isRegisteredRedirectUri(registered, "http://127.0.0.1:9999/cb?x=1"),
    ).toBe(false);
  });

  it("should not extend the port-only exception to a non-loopback host", () => {
    expect(
      isRegisteredRedirectUri(
        ["http://client.example:8080/cb"],
        "http://client.example:9999/cb",
      ),
    ).toBe(false);
  });
});

describe("isAllowedRedirectUriForRegistration", () => {
  it("should accept https:", () => {
    expect(
      isAllowedRedirectUriForRegistration("https://client.example/callback"),
    ).toBe(true);
  });

  it("should accept http: to loopback addresses", () => {
    expect(
      isAllowedRedirectUriForRegistration("http://127.0.0.1:51234/cb"),
    ).toBe(true);
    expect(
      isAllowedRedirectUriForRegistration("http://localhost:3000/cb"),
    ).toBe(true);
    expect(isAllowedRedirectUriForRegistration("http://[::1]:9000/cb")).toBe(
      true,
    );
  });

  it("should reject http: to a non-loopback host", () => {
    expect(
      isAllowedRedirectUriForRegistration("http://client.example/callback"),
    ).toBe(false);
  });

  it("should reject a non-URL string", () => {
    expect(isAllowedRedirectUriForRegistration("not a url")).toBe(false);
  });

  it("should reject a custom scheme", () => {
    expect(isAllowedRedirectUriForRegistration("myapp://callback")).toBe(false);
  });

  it("should reject a URI containing a fragment (RFC 6749 §3.1.2)", () => {
    expect(
      isAllowedRedirectUriForRegistration("https://client.example/cb#frag"),
    ).toBe(false);
    expect(
      isAllowedRedirectUriForRegistration("http://127.0.0.1:8080/cb#frag"),
    ).toBe(false);
  });
});
