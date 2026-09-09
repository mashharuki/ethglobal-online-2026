/**
 * One-time, human-run script (tasks.md Phase 10, specs/mcp-auth-remediation-plan.md §1.6/CI
 * section): mints the long-lived, non-rotating refresh token `apps/agent`'s CI harness uses to
 * authenticate its `discover_assets`/`buy_access`/`decrypt_content` calls to `/mcp`.
 *
 * This deliberately runs the REAL authorization_code + PKCE + consent flow against a live
 * deployed gateway - not a direct DB insert of a grant - because that is the one code path
 * `apps/agent` itself will depend on, and Constitution Principle III ("no mocks on the core
 * demo path") applies just as much to the credential the demo's own CI harness uses as to the
 * demo itself. A human must complete the browser consent step; this script cannot do it alone.
 *
 * Usage:
 *   DATABASE_URL=<direct Postgres URL, same one used for db:migrate> \
 *   GATEWAY_URL=https://<deployed-worker>.workers.dev \
 *   pnpm --filter gateway bootstrap:ci-oauth-client
 *
 * Prints a URL to open in a browser (logged in as whichever Privy identity should own the CI
 * grant), waits for the OAuth redirect on a local loopback listener, exchanges the code, and
 * prints the resulting `client_id` / refresh token to store as CI secrets
 * (`MCP_CI_CLIENT_ID` / `MCP_CI_REFRESH_TOKEN` - see apps/agent/src/auth.ts and
 * .github/workflows/ci.yml). Neither value is written to disk by this script.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { oauthClient } from "../src/db/schema";

const CI_CLIENT_NAME = "TrueCollective CI harness (apps/agent)";
const CI_SCOPE = "assets:read access:buy";
const CI_REDIRECT_PATH = "/callback";
// RFC 8252 §7.3: the authorization server ignores the port on a registered loopback URI, so
// registering with no port at all is deliberate - it never goes stale as the ephemeral port
// below changes from run to run (isRegisteredRedirectUri, redirectUri.ts).
const CI_REDIRECT_URI = `http://127.0.0.1${CI_REDIRECT_PATH}`;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** RFC 7636 §4.1: 43-128 chars of [A-Za-z0-9._~-]. 32 random bytes -> 43-char base64url,
 * matching the gateway's own CODE_VERIFIER_PATTERN lower bound (oauth/tokenHash.ts). */
function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

function sha256Base64Url(input: string): string {
  const digest = createHash("sha256").update(input).digest();
  return base64url(digest);
}

/**
 * Ensures the single pre-registered CI client exists (idempotent by client_name+source, so
 * re-running this script to mint a fresh token after losing the old one reuses the same
 * client_id rather than accumulating duplicate rows).
 *
 * Reuse is scoped to `source = "preregistered"`, not `client_name` alone (Codex review):
 * `client_name` is an attacker-controllable field on the public DCR endpoint
 * (`oauth/clients.ts`'s `registerClient`), so anyone could self-register a `source: "dcr"`
 * client under this exact name ahead of time. Matching on name alone would let this script
 * silently adopt that attacker-controlled client_id as "the" CI client. A matched
 * `preregistered` row is still expected to carry the exact configuration this script would
 * have created - a mismatch there means the DB row was hand-edited or came from a different
 * bootstrap version, and this refuses to guess which one is right rather than reusing a client
 * whose `redirect_uris`/`scope`/`refresh_rotation_disabled` might not be what's assumed below.
 */
async function ensureCiClient(db: ReturnType<typeof drizzle>): Promise<string> {
  const existing = await db
    .select({
      clientId: oauthClient.clientId,
      disabledAt: oauthClient.disabledAt,
      redirectUris: oauthClient.redirectUris,
      scope: oauthClient.scope,
      refreshRotationDisabled: oauthClient.refreshRotationDisabled,
    })
    .from(oauthClient)
    .where(
      and(
        eq(oauthClient.clientName, CI_CLIENT_NAME),
        eq(oauthClient.source, "preregistered"),
      ),
    );
  const live = existing.find((row) => row.disabledAt === null);
  if (live !== undefined) {
    const matchesExpectedConfig =
      live.scope === CI_SCOPE &&
      live.refreshRotationDisabled === true &&
      live.redirectUris.length === 1 &&
      live.redirectUris[0] === CI_REDIRECT_URI;
    if (!matchesExpectedConfig) {
      throw new Error(
        `an existing preregistered oauth_client ${live.clientId} named ${JSON.stringify(CI_CLIENT_NAME)} ` +
          "does not match this script's expected scope/redirect_uris/refresh_rotation_disabled - " +
          "resolve manually rather than reusing a client with unexpected configuration",
      );
    }
    console.error(`[bootstrap] reusing existing CI client ${live.clientId}`);
    return live.clientId;
  }
  const [row] = await db
    .insert(oauthClient)
    .values({
      clientId: crypto.randomUUID(),
      clientName: CI_CLIENT_NAME,
      redirectUris: [CI_REDIRECT_URI],
      scope: CI_SCOPE,
      source: "preregistered",
      refreshRotationDisabled: true,
    })
    .returning({ clientId: oauthClient.clientId });
  if (row === undefined)
    throw new Error("failed to insert CI oauth_client row");
  console.error(`[bootstrap] registered new CI client ${row.clientId}`);
  return row.clientId;
}

/** Binds an ephemeral loopback listener, prints the authorize URL, and resolves with the
 * authorization `code` once the browser is redirected back here (or rejects on a
 * state-matched `error`, a state-matched request with no code, or CALLBACK_TIMEOUT_MS of
 * silence). A request that doesn't match this run's `state` - stray traffic, a stale/reused
 * tab, someone else's process on the same loopback port - is answered and ignored WITHOUT
 * tearing down the listener or the timeout (Codex review): only a state-matched callback may
 * end the flow, and `state` is checked before `error` is ever acted on. */
async function awaitAuthorizationCode(
  authorizeUrl: URL,
  expectedState: string,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (url.pathname !== CI_REDIRECT_PATH) {
        res.writeHead(404).end();
        return;
      }
      const state = url.searchParams.get("state");
      if (state !== expectedState) {
        res
          .writeHead(400, { "content-type": "text/plain" })
          .end(
            "unrecognized request - ignored, still waiting for the real callback.",
          );
        return; // no timeout/server teardown: this was not the callback this run is waiting for
      }
      clearTimeout(timeout);
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const finish = (body: string, err?: Error): void => {
        res.writeHead(200, { "content-type": "text/plain" }).end(body);
        server.close();
        if (err !== undefined) reject(err);
      };
      if (error !== null) {
        finish(
          "Authorization was denied. You can close this tab.",
          new Error(`authorization denied: ${error}`),
        );
        return;
      }
      if (code === null || code === "") {
        finish(
          "no authorization code in the callback. You can close this tab.",
          new Error("callback had no code"),
        );
        return;
      }
      finish("Authorized. You can close this tab and return to the terminal.");
      resolvePromise(code);
    });
    const timeout = setTimeout(() => {
      server.close();
      reject(
        new Error(
          `no callback received within ${CALLBACK_TIMEOUT_MS / 1000}s - open the URL above and complete consent`,
        ),
      );
    }, CALLBACK_TIMEOUT_MS);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to bind an ephemeral loopback port"));
        return;
      }
      const redirectUri = `http://127.0.0.1:${address.port}${CI_REDIRECT_PATH}`;
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      console.log(
        "\nOpen this URL in a browser logged in as the Privy identity",
      );
      console.log(
        "that should own the CI grant, and approve the consent screen:\n",
      );
      console.log(authorizeUrl.toString());
      console.log(
        `\nWaiting up to ${CALLBACK_TIMEOUT_MS / 60000} minutes for the redirect...\n`,
      );
    });
  });
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  scope: string;
};

async function exchangeCode(
  gatewayUrl: string,
  input: {
    code: string;
    clientId: string;
    codeVerifier: string;
    redirectUri: string;
  },
): Promise<TokenResponse> {
  const response = await fetch(`${gatewayUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
      resource: `${gatewayUrl}/mcp`,
    }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  // Never echo the raw response body in an error message (Codex review): a 2xx body that fails
  // validation below still legitimately contains access_token/refresh_token, and dumping it
  // would print those secrets to the terminal / a captured log right after minting them.
  if (!response.ok) {
    const errorBody = (body ?? {}) as {
      error?: unknown;
      error_description?: unknown;
    };
    const error =
      typeof errorBody.error === "string" && errorBody.error.length > 0
        ? errorBody.error
        : "unknown_error";
    const description =
      typeof errorBody.error_description === "string" &&
      errorBody.error_description.length > 0
        ? `: ${errorBody.error_description}`
        : "";
    throw new Error(
      `/oauth/token exchange failed (${response.status} ${error}${description})`,
    );
  }
  const record = body as Partial<TokenResponse> | undefined;
  if (typeof record?.access_token !== "string") {
    throw new Error("/oauth/token response is missing a valid access_token");
  }
  if (typeof record?.refresh_token !== "string") {
    throw new Error("/oauth/token response is missing a valid refresh_token");
  }
  if (typeof record?.scope !== "string") {
    throw new Error("/oauth/token response is missing a valid scope");
  }
  return {
    access_token: record.access_token,
    refresh_token: record.refresh_token,
    scope: record.scope,
  };
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  const gatewayUrl = requireEnv("GATEWAY_URL").replace(/\/$/, "");

  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);
  let clientId: string;
  try {
    clientId = await ensureCiClient(db);
  } finally {
    await sql.end({ timeout: 5 });
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = sha256Base64Url(codeVerifier);
  const state = base64url(randomBytes(16));

  const authorizeUrl = new URL(`${gatewayUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("scope", CI_SCOPE);
  authorizeUrl.searchParams.set("resource", `${gatewayUrl}/mcp`);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  // redirect_uri (with the actual ephemeral port) is filled in by awaitAuthorizationCode once
  // the listener is bound, then re-read from the URL object for the token exchange below.
  const code = await awaitAuthorizationCode(authorizeUrl, state);
  const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
  if (redirectUri === null)
    throw new Error("internal error: redirect_uri was never set");

  const token = await exchangeCode(gatewayUrl, {
    code,
    clientId,
    codeVerifier,
    redirectUri,
  });

  console.log("\n=== Store these as CI secrets, then discard this output ===");
  console.log(
    `MCP_CI_CLIENT_ID (repository variable, not secret) = ${clientId}`,
  );
  console.log(
    `MCP_CI_REFRESH_TOKEN (repository SECRET)          = ${token.refresh_token}`,
  );
  console.log(`granted scope: ${token.scope}`);
  console.log("\nExample:");
  console.log(`  gh variable set MCP_CI_CLIENT_ID --body '${clientId}'`);
  console.log(
    "  gh secret set MCP_CI_REFRESH_TOKEN   # paste the token at the prompt",
  );
}

main().catch((error: unknown) => {
  console.error(
    "[bootstrap] failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
