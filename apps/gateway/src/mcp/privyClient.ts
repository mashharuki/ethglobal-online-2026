import { PrivyClient } from "@privy-io/node";
import type { Address, Hex } from "viem";
import type { Env } from "../env";

/**
 * Privy client + authorization-context plumbing for per-principal delegated AI wallets
 * (specs/mcp-auth-remediation-plan.md). Every signature the gateway asks Privy to produce on
 * a delegated wallet carries `authorization_context: { authorization_private_keys }` - the
 * P-256 key registered as a member of the wallet's signer quorum (PRIVY_SIGNER_QUORUM_ID) -
 * so the gateway never needs a user JWT in the loop (Phase-0 verified: `wallets().update()`
 * and `wallets().ethereum().signSecp256k1()` both accept `authorization_private_keys` alone
 * against the real installed SDK's types; whether Privy's server actually authorizes such a
 * request without a co-signing user_jwt is the one thing that still needs a live-API check,
 * tracked in the linked issue).
 */
export class PrivyDelegationUnavailableError extends Error {
  override readonly name = "PrivyDelegationUnavailableError";
}

// `Partial`, not `Pick`: `PRIVY_AI_WALLET_EXTERNAL_ID_PREFIX` is a required field on `Env`
// (it has a wrangler.toml default, unlike the secrets here), but `createPrivyDelegationClient`
// must accept a genuinely-incomplete object at the type level too - `requireEnv` below is the
// actual runtime validation, and a caller (or a test proving that validation) needs to be able
// to construct a value missing any subset of these fields without fighting the type checker.
// (Caught by the real `pnpm run typecheck` script - tsc --noEmit -p tsconfig.node.json for
// test files - which an earlier ad-hoc `tsc -b` in this same session was not exercising.)
export type PrivyDelegationEnv = Partial<
  Pick<
    Env,
    | "PRIVY_APP_ID"
    | "PRIVY_APP_SECRET"
    | "PRIVY_AUTHORIZATION_PRIVATE_KEY"
    | "PRIVY_SIGNER_QUORUM_ID"
    | "PRIVY_AI_WALLET_EXTERNAL_ID_PREFIX"
  >
>;

function requireEnv(
  env: PrivyDelegationEnv,
): asserts env is Required<PrivyDelegationEnv> {
  const missing = (
    [
      "PRIVY_APP_ID",
      "PRIVY_APP_SECRET",
      "PRIVY_AUTHORIZATION_PRIVATE_KEY",
      "PRIVY_SIGNER_QUORUM_ID",
      "PRIVY_AI_WALLET_EXTERNAL_ID_PREFIX",
    ] as const
  ).filter((name) => env[name] === undefined || env[name] === "");
  if (missing.length > 0) {
    throw new PrivyDelegationUnavailableError(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set`,
    );
  }
}

export function createPrivyDelegationClient(
  env: PrivyDelegationEnv,
  /** test-only: stub Privy at the HTTP boundary instead of mocking this module. */
  fetchImpl?: typeof fetch,
): {
  client: PrivyClient;
  signerQuorumId: string;
  externalIdPrefix: string;
  /** authorization_context to attach to every signing/update call on a delegated wallet */
  authorizationContext(): { authorization_private_keys: string[] };
} {
  requireEnv(env);
  const client = new PrivyClient({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
  return {
    client,
    signerQuorumId: env.PRIVY_SIGNER_QUORUM_ID,
    externalIdPrefix: env.PRIVY_AI_WALLET_EXTERNAL_ID_PREFIX,
    authorizationContext: () => ({
      authorization_private_keys: [env.PRIVY_AUTHORIZATION_PRIVATE_KEY],
    }),
  };
}

export type DelegatedPrivyWallet = {
  privyWalletId: string;
  address: Address;
  publicKey: Hex | undefined;
  additionalSignerIds: string[];
};

/**
 * Takes `unknown`, not `string` (Codex review): the SDK's `Wallet.address` field is typed
 * `string` at compile time, but that is not a runtime guarantee for JSON parsed off the
 * wire - `RegExp.test` coerces a non-string via `String(value)`, so a malformed response
 * shaped like `address: ["0x1111...1111"]` would otherwise pass the regex and the raw array
 * would escape this function cast as `Address`.
 */
function toAddress(value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new PrivyDelegationUnavailableError(
      `Privy wallet address is not a 20-byte EVM address: ${String(value)}`,
    );
  }
  return value as Address;
}

function toPublicKey(value: string | null | undefined): Hex | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
}

/**
 * Creates (or, given the same `externalId` + `idempotencyKey`, returns the already-created)
 * Privy wallet for one principal, with the gateway's signer quorum attached as an additional
 * signer (shape B, specs/mcp-auth-remediation-plan.md §1.6/wallet-delegation design - the
 * fallback owner-quorum shape is not implemented here and is a Phase-0-gated follow-up if
 * this shape doesn't work against real Privy).
 */
export async function createDelegatedWallet(
  delegation: ReturnType<typeof createPrivyDelegationClient>,
  input: { principalId: string; externalId: string; idempotencyKey: string },
): Promise<DelegatedPrivyWallet> {
  const wallets = delegation.client.wallets();
  const created = await wallets.create({
    chain_type: "ethereum",
    owner: { user_id: input.principalId },
    additional_signers: [{ signer_id: delegation.signerQuorumId }],
    external_id: input.externalId,
    idempotency_key: input.idempotencyKey,
  });
  return {
    privyWalletId: created.id,
    address: toAddress(created.address),
    publicKey: toPublicKey(created.public_key),
    additionalSignerIds: (created.additional_signers ?? []).map(
      (s) => s.signer_id,
    ),
  };
}

/** List-then-adopt fallback for a crashed-and-resumed provisioning attempt (idempotency
 * keys expire after 24h, so a retry past that window must find the wallet by external_id
 * instead of relying on Privy deduplicating the create call). */
export async function findDelegatedWalletByExternalId(
  delegation: ReturnType<typeof createPrivyDelegationClient>,
  input: { principalId: string; externalId: string },
): Promise<DelegatedPrivyWallet | undefined> {
  const wallets = delegation.client.wallets();
  const page = await wallets.list({
    user_id: input.principalId,
    chain_type: "ethereum",
  });
  for await (const wallet of page) {
    if (wallet.external_id === input.externalId) {
      return {
        privyWalletId: wallet.id,
        address: toAddress(wallet.address),
        publicKey: toPublicKey(wallet.public_key),
        additionalSignerIds: (wallet.additional_signers ?? []).map(
          (s) => s.signer_id,
        ),
      };
    }
  }
  return undefined;
}

/** Owner verification (specs/mcp-auth-remediation-plan.md §4): confirm Privy's own record of
 * the wallet's owner and the gateway's signer are what provisioning expects, from a fresh
 * server-side read - never trust a client-supplied wallet id/address at face value. */
export async function verifyDelegatedWalletOwnership(
  delegation: ReturnType<typeof createPrivyDelegationClient>,
  input: { principalId: string; privyWalletId: string },
): Promise<{ ownerVerified: boolean; signerAttached: boolean }> {
  const wallets = delegation.client.wallets();
  const wallet = await wallets.get(input.privyWalletId);
  const owned = await wallets.list({
    user_id: input.principalId,
    chain_type: "ethereum",
  });
  let ownerVerified = false;
  for await (const candidate of owned) {
    if (candidate.id === wallet.id) {
      ownerVerified = true;
      break;
    }
  }
  const signerAttached = (wallet.additional_signers ?? []).some(
    (s) => s.signer_id === delegation.signerQuorumId,
  );
  return { ownerVerified, signerAttached };
}

/** secp256k1 raw-hash signature via the gateway's authorization key - no user JWT. */
export async function signSecp256k1Delegated(
  delegation: ReturnType<typeof createPrivyDelegationClient>,
  input: { privyWalletId: string; hash: Hex },
): Promise<Hex> {
  const result = await delegation.client
    .wallets()
    .ethereum()
    .signSecp256k1(input.privyWalletId, {
      params: { hash: input.hash },
      authorization_context: delegation.authorizationContext(),
    });
  return result.signature as Hex;
}

type TypedDataInput = {
  readonly domain: Record<string, unknown>;
  readonly types: Record<
    string,
    ReadonlyArray<{ readonly name: string; readonly type: string }>
  >;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
};

function stringifyBigints<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as T;
}

/** EIP-712 signature via the gateway's authorization key - no user JWT. */
export async function signTypedDataDelegated(
  delegation: ReturnType<typeof createPrivyDelegationClient>,
  input: { privyWalletId: string; typedData: TypedDataInput },
): Promise<Hex> {
  const td = stringifyBigints(input.typedData);
  const types: Record<string, Array<{ name: string; type: string }>> = {};
  for (const [name, fields] of Object.entries(td.types)) {
    types[name] = fields.map((f) => ({ name: f.name, type: f.type }));
  }
  const result = await delegation.client
    .wallets()
    .ethereum()
    .signTypedData(input.privyWalletId, {
      params: {
        typed_data: {
          domain: td.domain,
          types,
          primary_type: td.primaryType,
          message: td.message,
        },
      },
      authorization_context: delegation.authorizationContext(),
    });
  return result.signature as Hex;
}

/**
 * Best-effort removal of the gateway's signer quorum from a delegated wallet
 * (specs/mcp-auth-remediation-plan.md "取消"). DB revocation (grant.ts's `revokeGrant`) is
 * what actually stops the Gateway from acting on this wallet's behalf - this call only tidies
 * up the Privy-side grant so a captured additional-signer credential can't be reused
 * elsewhere. A caller must treat its failure as retryable, never as the revoke itself failing
 * (DB revoke happens first and is authoritative on its own).
 */
export async function detachDelegatedSigner(
  delegation: ReturnType<typeof createPrivyDelegationClient>,
  privyWalletId: string,
): Promise<void> {
  await delegation.client.wallets().update(privyWalletId, {
    authorization_context: delegation.authorizationContext(),
    additional_signers: [],
  });
}

export class PrivyAuthUnavailableError extends Error {
  override readonly name = "PrivyAuthUnavailableError";
}

export type PrivyPrincipalAuthEnv = Partial<
  Pick<Env, "PRIVY_APP_ID" | "PRIVY_APP_SECRET">
>;

/**
 * Verifies a Privy access token minted by the user's OWN client-side Privy login (Phase 8/9
 * admin routes: agent-grant revocation). This is a SEPARATE trust boundary from the gateway's
 * own OAuth Bearer tokens (mcp/auth.ts's `requireMcpAuth`) - the two never cross paths, and
 * this function is never called from `/mcp`. A successful verification's `user_id` is exactly
 * the `principalId` used throughout `agent_grant`/`agent_wallet_binding` -
 * `createDelegatedWallet` above passes that same string as `owner.user_id` when a wallet is
 * first provisioned, so Privy's own record of "who owns this token" and "who owns this
 * wallet" are the same identifier space.
 *
 * `jwtVerificationKeyOverride` is a first-class SDK option (`PrivyClientOptions.
 * jwtVerificationKey`, `@privy-io/node`'s `lib/auth.js`), not test infrastructure this module
 * invented: passing a static SPKI PEM public key here makes verification purely local (no
 * JWKS fetch), which is what lets the test suite exercise the REAL `verifyAccessToken` /
 * `jose.jwtVerify` code path end-to-end (constitution III/IV) without a network stub - the
 * SDK's own `createRemoteJWKSet` call does not honor a custom `fetch` (it never receives one),
 * so an HTTP-boundary stub like the sibling functions in this module use would not work here.
 */
export async function verifyPrincipalAccessToken(
  env: PrivyPrincipalAuthEnv,
  accessToken: string,
  /** test-only: verify against a fixed key instead of Privy's live JWKS. */
  jwtVerificationKeyOverride?: string,
): Promise<{ principalId: string }> {
  if (env.PRIVY_APP_ID === undefined || env.PRIVY_APP_SECRET === undefined) {
    throw new PrivyAuthUnavailableError(
      "PRIVY_APP_ID / PRIVY_APP_SECRET are not set",
    );
  }
  const client = new PrivyClient({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    ...(jwtVerificationKeyOverride === undefined
      ? {}
      : { jwtVerificationKey: jwtVerificationKeyOverride }),
  });
  const verified = await client.utils().auth().verifyAccessToken(accessToken);
  return { principalId: verified.user_id };
}
