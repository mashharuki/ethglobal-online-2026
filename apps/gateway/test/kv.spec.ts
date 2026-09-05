import { env } from "cloudflare:test";
import { encryptShareG, KvFormatError, shareGKvKey } from "@truenft/shared";
import { type Hex, hexToBytes } from "viem";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
  hasShareG,
  loadShareG,
  putEncryptedShareG,
  ShareNotLoadedError,
} from "../src/kv/shareStore";

const KEK = `0x${"11".repeat(32)}` as Hex;
const OTHER_KEK = `0x${"22".repeat(32)}` as Hex;
const SHARE = hexToBytes(`0x${"c3".repeat(32)}`);
/** Distinct asset per test: the KV namespace is shared across tests in this file. */
const asset = (byte: string): Hex => `0x${byte.repeat(32)}`;

const testEnv: Env = { ...env, KV_KEK: KEK };

describe("SHARE_G KV store (T076, FR-016)", () => {
  it("should round-trip a share_G blob written with packages/shared kv-format", async () => {
    const id = asset("a1");
    const blob = await encryptShareG(SHARE, hexToBytes(KEK), id);
    await putEncryptedShareG(testEnv, id, blob);
    expect(await hasShareG(testEnv, id)).toBe(true);
    expect(await loadShareG(testEnv, id)).toEqual(SHARE);
  });

  it("should report a missing share as ShareNotLoadedError", async () => {
    const id = asset("a2");
    expect(await hasShareG(testEnv, id)).toBe(false);
    await expect(loadShareG(testEnv, id)).rejects.toBeInstanceOf(
      ShareNotLoadedError,
    );
  });

  it("should fail authentication with the wrong KEK", async () => {
    const id = asset("a3");
    const blob = await encryptShareG(SHARE, hexToBytes(OTHER_KEK), id);
    await putEncryptedShareG(testEnv, id, blob);
    await expect(loadShareG(testEnv, id)).rejects.toBeInstanceOf(KvFormatError);
  });

  it("should reject a blob moved from one asset's key to another (AAD binding)", async () => {
    const source = asset("a4");
    const target = asset("a5");
    const blob = await encryptShareG(SHARE, hexToBytes(KEK), source);
    await env.SHARE_G.put(shareGKvKey(target), blob);
    await expect(loadShareG(testEnv, target)).rejects.toBeInstanceOf(
      KvFormatError,
    );
  });

  it("should refuse to store anything that is not tc-kv-v1 ciphertext", async () => {
    const id = asset("a6");
    await expect(
      putEncryptedShareG(testEnv, id, `0x${"c3".repeat(32)}`),
    ).rejects.toThrow(/tc-kv-v1/);
    expect(await hasShareG(testEnv, id)).toBe(false);
  });

  it("should fail closed when KV_KEK is not configured", async () => {
    const id = asset("a7");
    const blob = await encryptShareG(SHARE, hexToBytes(KEK), id);
    await putEncryptedShareG(testEnv, id, blob);
    await expect(loadShareG({ ...env, KV_KEK: undefined }, id)).rejects.toThrow(
      /KV_KEK/,
    );
  });
});
