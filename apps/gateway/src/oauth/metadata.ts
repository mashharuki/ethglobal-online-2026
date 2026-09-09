/**
 * OAuth discovery documents (specs/mcp-auth-remediation-plan.md §6): RFC 9728 Protected
 * Resource Metadata (what tells an MCP client which authorization server protects `/mcp`) and
 * RFC 8414 Authorization Server Metadata (what tells it how to talk to that server). Both are
 * built from `origin` (the gateway's own base URL as seen on this request) rather than a fixed
 * config value - this server is only ever its own issuer, so there is nothing to pin ahead of
 * time, and deriving it from the request keeps this correct across the workers.dev subdomain,
 * a custom domain, and local dev without separate configuration for each.
 */
export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
};

export function buildProtectedResourceMetadata(
  origin: string,
): ProtectedResourceMetadata {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
  };
}

export type AuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  registration_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
};

/** `scopes_supported` mirrors the space-delimited scope tokens grant.ts/agent_grant actually
 * enforces (`assets:read`, `access:buy`) - advertising a scope this server can't actually
 * grant would be misleading to a client choosing what to request. Exported so
 * oauth/authorize.ts can validate a request's `scope` against the same list. */
export const SCOPES_SUPPORTED = ["assets:read", "access:buy"];

export function buildAuthorizationServerMetadata(
  origin: string,
): AuthorizationServerMetadata {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: SCOPES_SUPPORTED,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}
