import { env } from "cloudflare:test";
import { encryptShareG, shareGKvKey } from "@truenft/shared";
import { type Hex, hexToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { signClaims, verifyClaims } from "../src/auth/session";
import type { Env } from "../src/env";
import {
  decryptWithKey,
  fallbackDecrypt,
  issueFallbackGrant,
  verifyFallbackGrant,
} from "../src/keygate/fallback";
import { shareUSecretName } from "../src/keygate/vault";

const SECRET = hexToBytes(`0x${"0f".repeat(32)}`);
const ASSET = `0x${"a5".repeat(32)}` as Hex;
const WALLET = "0x00000000000000000000000000000000000000a1";

describe("signed claims (owner session / fallback grant)", () => {
  it("should round-trip claims and reject tampering, expiry and purpose confusion", async () => {
    const token = await signClaims(SECRET, "owner-session", {
      assetId: ASSET,
      wallet: WALLET,
      accessEpochAtGrant: "3",
      expiresAt: 2_000,
    });
    expect(
      await verifyClaims(SECRET, "owner-session", token, 1_000),
    ).toMatchObject({ accessEpochAtGrant: "3" });
    expect(
      await verifyClaims(SECRET, "owner-session", token, 2_000),
    ).toBeUndefined();
    expect(
      await verifyClaims(SECRET, "fallback-grant", token, 1_000),
    ).toBeUndefined();
    const flipped = `${token.slice(0, -2)}${token.endsWith("00") ? "01" : "00"}`;
    expect(
      await verifyClaims(SECRET, "owner-session", flipped, 1_000),
    ).toBeUndefined();
    expect(
      await verifyClaims(SECRET, "owner-session", "not-hex", 1_000),
    ).toBeUndefined();
    expect(
      await verifyClaims(
        hexToBytes(`0x${"1f".repeat(32)}`),
        "owner-session",
        token,
        1_000,
      ),
    ).toBeUndefined();
  });
});

describe("fallback path (T077 (2), disclosed trust point)", () => {
  const KEK = `0x${"11".repeat(32)}` as Hex;
  const contentKey = hexToBytes(`0x${"77".repeat(32)}`);
  const shareG = hexToBytes(`0x${"33".repeat(32)}`);
  const shareU = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1)
    shareU[i] = (contentKey[i] ?? 0) ^ (shareG[i] ?? 0);

  async function fallbackEnv(): Promise<Env> {
    await env.SHARE_G.put(
      shareGKvKey(ASSET),
      await encryptShareG(shareG, hexToBytes(KEK), ASSET),
    );
    return {
      ...env,
      KV_KEK: KEK,
      RECEIPT_SIGNER_KEY: `0x${"0f".repeat(32)}`,
      [shareUSecretName(ASSET)]:
        `0x${"".concat(...Array.from(shareU, (b) => b.toString(16).padStart(2, "0")))}`,
    } as Env;
  }

  it("should issue a grant bound to the asset and reject it for another asset or after expiry", async () => {
    const e = await fallbackEnv();
    const grant = await issueFallbackGrant(e, {
      assetId: ASSET,
      wallet: WALLET,
      path: "owner",
      nowSec: 1_000,
    });
    expect(grant.expiresAt).toBe(1_300);
    expect(
      await verifyFallbackGrant(e, grant.token, ASSET, 1_100),
    ).toMatchObject({ wallet: WALLET, path: "owner" });
    expect(
      await verifyFallbackGrant(e, grant.token, `0x${"b6".repeat(32)}`, 1_100),
    ).toBeUndefined();
    expect(
      await verifyFallbackGrant(e, grant.token, ASSET, 1_300),
    ).toBeUndefined();
  });

  it("should reconstruct K from both shares and decrypt iv||ct||tag content produced with K", async () => {
    const e = await fallbackEnv();
    const key = await crypto.subtle.importKey(
      "raw",
      contentKey,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode("secret content"),
      ),
    );
    const blob = new Uint8Array(12 + ct.length);
    blob.set(iv, 0);
    blob.set(ct, 12);
    expect(
      new TextDecoder().decode(await fallbackDecrypt(e, ASSET, blob)),
    ).toBe("secret content");
    await expect(
      decryptWithKey(hexToBytes(`0x${"78".repeat(32)}`), blob),
    ).rejects.toThrow();
  });
});
