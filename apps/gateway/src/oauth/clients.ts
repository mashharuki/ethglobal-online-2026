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

export type RegisterClientInput = {
  clientName: string;
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
  if (input.clientName.trim().length === 0) {
    throw new AppError(
      "CONSENT_REQUEST_INVALID",
      "client_name must not be empty",
    );
  }
  if (input.redirectUris.length === 0) {
    throw new AppError(
      "CONSENT_REQUEST_INVALID",
      "redirect_uris must contain at least one URI",
    );
  }
  for (const uri of input.redirectUris) {
    if (!isAllowedRedirectUriForRegistration(uri)) {
      throw new AppError(
        "CONSENT_REQUEST_INVALID",
        `redirect_uri is not allowed: ${uri} (must be https:, or http: to a loopback address)`,
      );
    }
  }
  const [row] = await db
    .insert(oauthClient)
    .values({
      clientId: crypto.randomUUID(),
      clientName: input.clientName,
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
