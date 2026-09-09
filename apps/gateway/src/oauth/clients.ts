import { eq } from "drizzle-orm";
import { oauthClient } from "../db/schema";
import type { AuthzDb } from "../db/types";
import { AppError } from "../errors";
import { isAllowedRedirectUriForRegistration } from "./redirectUri";

/**
 * OAuth client registration and lookup (RFC 7591 Dynamic Client Registration,
 * specs/mcp-auth-remediation-plan.md §6). Every client here is a public client
 * (`token_endpoint_auth_method = "none"`, enforced by oauth_client's own CHECK constraint) -
 * this codebase never issues or verifies a client secret. `agent_grant_live_principal_client_unique`
 * (schema.ts) is what actually stops one client from accumulating multiple simultaneous active
 * grants per principal, not anything in this module.
 */
export type OauthClient = typeof oauthClient.$inferSelect;

// RFC 7591 makes every field here optional except redirect_uris - client_name has no
// mandated limit, but the DB column is NOT NULL, so an omitted name gets this fallback rather
// than a schema change. The length/count caps (Codex review) exist purely to bound storage
// growth and validation work on this deliberately-unauthenticated endpoint, not because the
// RFC requires them.
const MAX_CLIENT_NAME_LENGTH = 200;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2000;
const UNNAMED_CLIENT_FALLBACK = "Unnamed client";

export type RegisterClientInput = {
  clientName?: string;
  redirectUris: string[];
  scope?: string;
};

/**
 * RFC 7591 client registration. `client_id` is a fresh random value (RFC 7591 doesn't mandate
 * a shape) - `crypto.randomUUID()` is unguessable and already the convention this codebase
 * uses for every other synthetic id.
 */
export async function registerClient(
  db: AuthzDb,
  input: RegisterClientInput,
): Promise<OauthClient> {
  const clientName = input.clientName?.trim() || UNNAMED_CLIENT_FALLBACK;
  if (clientName.length > MAX_CLIENT_NAME_LENGTH) {
    throw new AppError(
      "CONSENT_REQUEST_INVALID",
      `client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`,
    );
  }
  if (input.redirectUris.length === 0) {
    throw new AppError(
      "CONSENT_REQUEST_INVALID",
      "redirect_uris must contain at least one URI",
    );
  }
  if (input.redirectUris.length > MAX_REDIRECT_URIS) {
    throw new AppError(
      "CONSENT_REQUEST_INVALID",
      `redirect_uris must contain at most ${MAX_REDIRECT_URIS} URIs`,
    );
  }
  for (const uri of input.redirectUris) {
    if (uri.length > MAX_REDIRECT_URI_LENGTH) {
      throw new AppError(
        "CONSENT_REQUEST_INVALID",
        `redirect_uri exceeds ${MAX_REDIRECT_URI_LENGTH} characters`,
      );
    }
    if (!isAllowedRedirectUriForRegistration(uri)) {
      throw new AppError(
        "CONSENT_REQUEST_INVALID",
        `redirect_uri is not allowed: ${uri} (must be https:, or http: to a loopback address, with no fragment)`,
      );
    }
  }
  const [row] = await db
    .insert(oauthClient)
    .values({
      clientId: crypto.randomUUID(),
      clientName,
      redirectUris: input.redirectUris,
      scope: input.scope,
      source: "dcr",
    })
    .returning();
  if (row === undefined) {
    throw new AppError("CONSENT_REQUEST_INVALID", "client registration failed");
  }
  return row;
}

export async function resolveClient(
  db: AuthzDb,
  clientId: string,
): Promise<OauthClient | undefined> {
  const [row] = await db
    .select()
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  return row;
}

/** Throws if the client doesn't exist or has been disabled - the specific denial reason
 * callers (an HTTP route) can surface as-is. */
export async function assertClientUsable(
  db: AuthzDb,
  clientId: string,
): Promise<OauthClient> {
  const client = await resolveClient(db, clientId);
  if (client === undefined || client.disabledAt !== null) {
    throw new AppError(
      "CONSENT_REQUEST_INVALID",
      "unknown or disabled client_id",
    );
  }
  return client;
}
