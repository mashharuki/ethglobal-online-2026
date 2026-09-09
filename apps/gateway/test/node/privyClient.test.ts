import { generateKeyPairSync } from "node:crypto";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  createDelegatedWallet,
  createPrivyDelegationClient,
  detachDelegatedSigner,
  findDelegatedWalletByExternalId,
  PrivyAuthUnavailableError,
  PrivyDelegationUnavailableError,
  signSecp256k1Delegated,
  signTypedDataDelegated,
  verifyDelegatedWalletOwnership,
  verifyPrincipalAccessToken,
} from "../../src/mcp/privyClient";

/**
 * Privy is stubbed at the HTTP boundary (a fake `fetch`), not by mocking privyClient.ts
 * itself - these tests exercise the real @privy-io/node request/response wiring
 * (constitution III/IV: no mocks on the module under test). Endpoints and response shapes
 * below are read from the installed @privy-io/node@0.34.0 source
 * (public-api/services/wallets.ts, resources/wallets/wallets.ts), not guessed.
 */
// A P-256 PKCS8 private key, base64-encoded, generated fresh for this test run - never
// hardcoded (a static literal here would be a real, valid private key checked into git
// history and flagged by secret scanning, even though it's never used for anything but
// signing throwaway HTTP requests to a fake fetch stub within this process). Generated at
// module load, not lazily: @privy-io/node's prepareRequest actually parses and signs with
// this, so a placeholder string would throw before reaching the network stub.
const AUTHORIZATION_PRIVATE_KEY = generateKeyPairSync("ec", {
  namedCurve: "P-256",
})
  .privateKey.export({ type: "pkcs8", format: "der" })
  .toString("base64");

const ENV = {
  PRIVY_APP_ID: "app-id",
  PRIVY_APP_SECRET: "app-secret",
  PRIVY_AUTHORIZATION_PRIVATE_KEY: AUTHORIZATION_PRIVATE_KEY,
  PRIVY_SIGNER_QUORUM_ID: "quorum-1",
  PRIVY_AI_WALLET_EXTERNAL_ID_PREFIX: "aiwallet",
};

const WALLET_ADDRESS = "0x1111111111111111111111111111111111111111";

function fakeFetch(
  handler: (req: {
    method: string;
    url: string;
    body: unknown;
    headers: Headers;
  }) => unknown,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init?.headers);
    const result = handler({ method, url, body, headers });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("createPrivyDelegationClient", () => {
  it("should throw PrivyDelegationUnavailableError naming every missing var", () => {
    expect(() => createPrivyDelegationClient({})).toThrow(
      PrivyDelegationUnavailableError,
    );
    try {
      createPrivyDelegationClient({ PRIVY_APP_ID: "x" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PrivyDelegationUnavailableError);
      expect((error as Error).message).toContain("PRIVY_APP_SECRET");
      expect((error as Error).message).toContain(
        "PRIVY_AUTHORIZATION_PRIVATE_KEY",
      );
      expect((error as Error).message).toContain("PRIVY_SIGNER_QUORUM_ID");
      expect((error as Error).message).not.toContain("PRIVY_APP_ID,");
    }
  });

  it("should reject an empty-string var the same as an unset one", () => {
    expect(() =>
      createPrivyDelegationClient({ ...ENV, PRIVY_SIGNER_QUORUM_ID: "" }),
    ).toThrow(PrivyDelegationUnavailableError);
  });
});

describe("createDelegatedWallet", () => {
  it("should POST /v1/wallets with owner/additional_signers/external_id in the body, the idempotency key as a header, and parse the response", async () => {
    let capturedBody: unknown;
    let capturedHeaders: Headers | undefined;
    const fetchImpl = fakeFetch(({ method, url, body, headers }) => {
      expect(method).toBe("POST");
      expect(url).toBe("https://api.privy.io/v1/wallets");
      capturedBody = body;
      capturedHeaders = headers;
      return {
        id: "wallet-1",
        address: WALLET_ADDRESS,
        chain_type: "ethereum",
        public_key: "02aabbcc",
        additional_signers: [{ signer_id: "quorum-1" }],
      };
    });
    const delegation = createPrivyDelegationClient(ENV, fetchImpl);
    const wallet = await createDelegatedWallet(delegation, {
      principalId: "did:privy:abc",
      externalId: "aiwallet-abc-0",
      idempotencyKey: "aiwallet:v1:did:privy:abc:0",
    });
    expect(capturedBody).toMatchObject({
      chain_type: "ethereum",
      owner: { user_id: "did:privy:abc" },
      additional_signers: [{ signer_id: "quorum-1" }],
      external_id: "aiwallet-abc-0",
    });
    // idempotency_key is extracted out of the body and sent as this header instead
    // (the SDK's own WalletCreateParams destructures it before building the request body)
    expect(capturedHeaders?.get("privy-idempotency-key")).toBe(
      "aiwallet:v1:did:privy:abc:0",
    );
    expect(wallet).toEqual({
      privyWalletId: "wallet-1",
      address: WALLET_ADDRESS,
      publicKey: "0x02aabbcc",
      additionalSignerIds: ["quorum-1"],
    });
  });

  it("should reject a non-20-byte-hex address instead of returning it uninspected", async () => {
    const fetchImpl = fakeFetch(() => ({
      id: "wallet-1",
      address: "not-an-address",
      chain_type: "ethereum",
      additional_signers: [],
    }));
    const delegation = createPrivyDelegationClient(ENV, fetchImpl);
    await expect(
      createDelegatedWallet(delegation, {
        principalId: "did:privy:abc",
        externalId: "aiwallet-abc-0",
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(PrivyDelegationUnavailableError);
  });
});

describe("findDelegatedWalletByExternalId", () => {
  it("should page through the list and match by external_id, ignoring others", async () => {
    const fetchImpl = fakeFetch(({ method, url }) => {
      expect(method).toBe("GET");
      expect(url).toContain("/v1/wallets");
      return {
        data: [
          {
            id: "wallet-other",
            address: "0x2222222222222222222222222222222222222222",
            chain_type: "ethereum",
            external_id: "aiwallet-abc-999",
            additional_signers: [],
          },
          {
            id: "wallet-1",
            address: WALLET_ADDRESS,
            chain_type: "ethereum",
            external_id: "aiwallet-abc-0",
            additional_signers: [{ signer_id: "quorum-1" }],
          },
        ],
        next_cursor: null,
      };
    });
    const delegation = createPrivyDelegationClient(ENV, fetchImpl);
    const found = await findDelegatedWalletByExternalId(delegation, {
      principalId: "did:privy:abc",
      externalId: "aiwallet-abc-0",
    });
    expect(found?.privyWalletId).toBe("wallet-1");
  });

  it("should return undefined when no wallet matches the external_id", async () => {
    const fetchImpl = fakeFetch(() => ({ data: [], next_cursor: null }));
    const delegation = createPrivyDelegationClient(ENV, fetchImpl);
    const found = await findDelegatedWalletByExternalId(delegation, {
      principalId: "did:privy:abc",
      externalId: "aiwallet-abc-0",
    });
    expect(found).toBeUndefined();
  });
});

describe("verifyDelegatedWalletOwnership", () => {
  it("should confirm ownership and signer attachment from two independent server reads", async () => {
    const fetchImpl = fakeFetch(({ method, url }) => {
      if (method === "GET" && url.endsWith("/v1/wallets/wallet-1")) {
        return {
          id: "wallet-1",
          address: WALLET_ADDRESS,
          chain_type: "ethereum",
          additional_signers: [{ signer_id: "quorum-1" }],
        };
      }
      return {
        data: [
          {
            id: "wallet-1",
            address: WALLET_ADDRESS,
            chain_type: "ethereum",
            additional_signers: [{ signer_id: "quorum-1" }],
          },
        ],
        next_cursor: null,
      };
    });
    const delegation = createPrivyDelegationClient(ENV, fetchImpl);
    const result = await verifyDelegatedWalletOwnership(delegation, {
      principalId: "did:privy:abc",
      privyWalletId: "wallet-1",
    });
    expect(result).toEqual({ ownerVerified: true, signerAttached: true });
  });

  it("should report signerAttached: false when the gateway's quorum is missing", async () => {
    const fetchImpl = fakeFetch(({ method, url }) => {
      if (method === "GET" && url.endsWith("/v1/wallets/wallet-1")) {
        return {
          id: "wallet-1",
          address: WALLET_ADDRESS,
          chain_type: "ethereum",
          additional_signers: [],
        };
      }
      return {
        data: [
          {
            id: "wallet-1",
            address: WALLET_ADDRESS,
            chain_type: "ethereum",
            additional_signers: [],
          },
        ],
        next_cursor: null,
      };
    });
    const delegation = createPrivyDelegationClient(ENV, fetchImpl);
    const result = await verifyDelegatedWalletOwnership(delegation, {
      principalId: "did:privy:abc",
      privyWalletId: "wallet-1",
    });
    expect(result).toEqual({ ownerVerified: true, signerAttached: false });
  });

  it("should report ownerVerified: false when the wallet does not appear in the principal's own list", async () => {
    const fetchImpl = fakeFetch(({ method, url }) => {
      if (method === "GET" && url.endsWith("/v1/wallets/wallet-1")) {
        return {
          id: "wallet-1",
          address: WALLET_ADDRESS,
          chain_type: "ethereum",
          additional_signers: [{ signer_id: "quorum-1" }],
        };
      }
      return { data: [], next_cursor: null };
    });
    const delegation = createPrivyDelegationClient(ENV, fetchImpl);
    const result = await verifyDelegatedWalletOwnership(delegation, {
      principalId: "did:privy:abc",
      privyWalletId: "wallet-1",
    });
    expect(result.ownerVerified).toBe(false);
  });
});

/**
 * Asserts the raw PRIVY_AUTHORIZATION_PRIVATE_KEY string never appears anywhere on the
 * wire (Codex review: header-presence alone doesn't prove the key wasn't also echoed in
 * plaintext) - only a derived signature should cross the HTTP boundary.
 */
function assertRawKeyNeverSent(req: {
  url: string;
  body: unknown;
  headers: Headers;
}): void {
  expect(req.url).not.toContain(AUTHORIZATION_PRIVATE_KEY);
  expect(JSON.stringify(req.body ?? "")).not.toContain(
    AUTHORIZATION_PRIVATE_KEY,
  );
  for (const value of req.headers.values()) {
    expect(value).not.toContain(AUTHORIZATION_PRIVATE_KEY);
  }
}

describe("signSecp256k1Delegated", () => {
  it("should POST /v1/wallets/{id}/rpc with the authorization_context and return the signature, without leaking the raw key", async () => {
    let capturedBody: unknown;
    let capturedHeaders: Headers | undefined;
    const fetchImpl = fakeFetch(({ method, url, body, headers }) => {
      expect(method).toBe("POST");
      expect(url).toBe("https://api.privy.io/v1/wallets/wallet-1/rpc");
      capturedBody = body;
      capturedHeaders = headers;
      assertRawKeyNeverSent({ url, body, headers });
      return {
        method: "secp256k1_sign",
        data: { encoding: "hex", signature: "0xdeadbeef" },
      };
    });
    const delegation = createPrivyDelegationClient(ENV, fetchImpl);
    const signature = await signSecp256k1Delegated(delegation, {
      privyWalletId: "wallet-1",
      hash: `0x${"00".repeat(32)}`,
    });
    expect(signature).toBe("0xdeadbeef");
    expect(capturedBody).toMatchObject({
      method: "secp256k1_sign",
      chain_type: "ethereum",
      params: { hash: `0x${"00".repeat(32)}` },
    });
    // the authorization key must actually reach the wire: @privy-io/node's prepareRequest
    // (src/lib/authorization.ts) turns authorization_private_keys into a P-256 signature
    // over the request, attached as this header - never echoed as plaintext in the body.
    expect(capturedHeaders?.has("privy-authorization-signature")).toBe(true);
  });
});

describe("signTypedDataDelegated", () => {
  it("should POST /v1/wallets/{id}/rpc with the EIP-712 payload and authorization header, without leaking the raw key", async () => {
    let capturedBody: unknown;
    const fetchImpl = fakeFetch(({ method, url, body, headers }) => {
      expect(method).toBe("POST");
      expect(url).toBe("https://api.privy.io/v1/wallets/wallet-1/rpc");
      capturedBody = body;
      assertRawKeyNeverSent({ url, body, headers });
      expect(headers.has("privy-authorization-signature")).toBe(true);
      return {
        method: "eth_signTypedData_v4",
        data: { encoding: "hex", signature: "0xtypeddatasig" },
      };
    });
    const delegation = createPrivyDelegationClient(ENV, fetchImpl);
    const signature = await signTypedDataDelegated(delegation, {
      privyWalletId: "wallet-1",
      typedData: {
        domain: { name: "TrueCollective", chainId: 296n },
        types: { Mail: [{ name: "contents", type: "string" }] },
        primaryType: "Mail",
        message: { contents: "hello" },
      },
    });
    expect(signature).toBe("0xtypeddatasig");
    expect(capturedBody).toMatchObject({
      method: "eth_signTypedData_v4",
      chain_type: "ethereum",
      params: {
        typed_data: {
          // bigint fields must be stringified before crossing the JSON boundary
          domain: { name: "TrueCollective", chainId: "296" },
          primary_type: "Mail",
          message: { contents: "hello" },
        },
      },
    });
  });
});

describe("detachDelegatedSigner", () => {
  it("should update the wallet with an empty additional_signers array, authorized, without leaking the raw key", async () => {
    let capturedBody: unknown;
    const fetchImpl = fakeFetch(({ method, url, body, headers }) => {
      expect(method).toBe("PATCH");
      expect(url).toBe("https://api.privy.io/v1/wallets/wallet-1");
      capturedBody = body;
      assertRawKeyNeverSent({ url, body, headers });
      expect(headers.has("privy-authorization-signature")).toBe(true);
      return {
        id: "wallet-1",
        address: WALLET_ADDRESS,
        chain_type: "ethereum",
        additional_signers: [],
      };
    });
    const delegation = createPrivyDelegationClient(ENV, fetchImpl);
    await detachDelegatedSigner(delegation, "wallet-1");
    expect(capturedBody).toMatchObject({ additional_signers: [] });
  });
});

/**
 * verifyPrincipalAccessToken (Phase 8 agent-grant revocation). Privy's own `verifyAccessToken`
 * / `jose.jwtVerify` is exercised for real (constitution III/IV) via `jwtVerificationKey` - a
 * first-class SDK option for supplying a static SPKI public key, which makes verification
 * purely local. This is the correct seam here (not an HTTP `fetch` stub like the tests above):
 * @privy-io/node's `createPrivyAppJWKS` never receives the client's custom `fetch`, so an
 * HTTP-boundary stub for the JWKS endpoint would not actually be reachable from outside.
 */
describe("verifyPrincipalAccessToken", () => {
  const APP_ID = "app-id";

  async function buildToken(overrides: {
    userId?: string;
    sessionId?: string;
    issuer?: string;
    audience?: string;
    expiresInSeconds?: number;
    signWithDifferentKey?: boolean;
  } = {}): Promise<{ token: string; verificationKeyPem: string }> {
    const { publicKey, privateKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const signingKey = overrides.signWithDifferentKey
      ? (await generateKeyPair("ES256", { extractable: true })).privateKey
      : privateKey;
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sid: overrides.sessionId ?? "session-1" })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setIssuer(overrides.issuer ?? "privy.io")
      .setAudience(overrides.audience ?? APP_ID)
      .setSubject(overrides.userId ?? "did:privy:abc")
      .setIssuedAt(now)
      .setExpirationTime(now + (overrides.expiresInSeconds ?? 3600))
      .sign(signingKey);
    return { token, verificationKeyPem: await exportSPKI(publicKey) };
  }

  it("should return the principalId (Privy's user_id / sub claim) for a valid token", async () => {
    const { token, verificationKeyPem } = await buildToken({
      userId: "did:privy:user-1",
    });
    const result = await verifyPrincipalAccessToken(
      { PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: "secret" },
      token,
      verificationKeyPem,
    );
    expect(result).toEqual({ principalId: "did:privy:user-1" });
  });

  it("should reject a token minted for a different Privy app (audience mismatch)", async () => {
    const { token, verificationKeyPem } = await buildToken({
      audience: "some-other-app-id",
    });
    await expect(
      verifyPrincipalAccessToken(
        { PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: "secret" },
        token,
        verificationKeyPem,
      ),
    ).rejects.toThrow();
  });

  it("should reject a token from an issuer other than privy.io", async () => {
    const { token, verificationKeyPem } = await buildToken({
      issuer: "https://attacker.example",
    });
    await expect(
      verifyPrincipalAccessToken(
        { PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: "secret" },
        token,
        verificationKeyPem,
      ),
    ).rejects.toThrow();
  });

  it("should reject an expired token", async () => {
    const { token, verificationKeyPem } = await buildToken({
      expiresInSeconds: -60,
    });
    await expect(
      verifyPrincipalAccessToken(
        { PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: "secret" },
        token,
        verificationKeyPem,
      ),
    ).rejects.toThrow();
  });

  it("should reject a token whose signature does not verify against the expected key", async () => {
    const { token, verificationKeyPem } = await buildToken({
      signWithDifferentKey: true,
    });
    await expect(
      verifyPrincipalAccessToken(
        { PRIVY_APP_ID: APP_ID, PRIVY_APP_SECRET: "secret" },
        token,
        verificationKeyPem,
      ),
    ).rejects.toThrow();
  });

  it("should throw PrivyAuthUnavailableError when PRIVY_APP_ID / PRIVY_APP_SECRET are not set", async () => {
    await expect(
      verifyPrincipalAccessToken({}, "irrelevant-token"),
    ).rejects.toThrow(PrivyAuthUnavailableError);
    await expect(
      verifyPrincipalAccessToken(
        { PRIVY_APP_ID: APP_ID },
        "irrelevant-token",
      ),
    ).rejects.toThrow(PrivyAuthUnavailableError);
  });
});
