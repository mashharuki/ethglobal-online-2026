import { describe, expect, it } from "vitest";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from "../../src/oauth/metadata";

const ORIGIN = "https://truecollective-gateway.example.workers.dev";

describe("buildProtectedResourceMetadata", () => {
  it("should point resource at /mcp under the given origin and list that origin as the authorization server", () => {
    const metadata = buildProtectedResourceMetadata(ORIGIN);
    expect(metadata.resource).toBe(`${ORIGIN}/mcp`);
    expect(metadata.authorization_servers).toEqual([ORIGIN]);
  });
});

describe("buildAuthorizationServerMetadata", () => {
  it("should derive every endpoint from the given origin", () => {
    const metadata = buildAuthorizationServerMetadata(ORIGIN);
    expect(metadata.issuer).toBe(ORIGIN);
    expect(metadata.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(metadata.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(metadata.revocation_endpoint).toBe(`${ORIGIN}/oauth/revoke`);
    expect(metadata.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
  });

  it("should advertise exactly S256 PKCE and the 'none' client auth method", () => {
    const metadata = buildAuthorizationServerMetadata(ORIGIN);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("should advertise both grant types this server actually implements", () => {
    const metadata = buildAuthorizationServerMetadata(ORIGIN);
    expect(metadata.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
  });
});
