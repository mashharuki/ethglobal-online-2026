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

  it("should reject a query string appended to an otherwise-exact match", () => {
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
});
