import { env } from "cloudflare:test";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  readKek,
  readReceiptSignerKey,
  readShareU,
  shareUSecretName,
  wipe,
} from "../src/keygate/vault";

const ASSET = `0x${"ab".repeat(32)}` as Hex;

describe("secrets accessors (T076, data-model 2.4)", () => {
  it("should parse KV_KEK with or without 0x and require 32 bytes", () => {
    expect(readKek({ KV_KEK: `0x${"01".repeat(32)}` })).toHaveLength(32);
    expect(readKek({ KV_KEK: "02".repeat(32) })).toHaveLength(32);
    expect(() => readKek({ KV_KEK: "03".repeat(16) })).toThrow(/32 bytes/);
    expect(() => readKek({ KV_KEK: "zz".repeat(32) })).toThrow(/hex/);
    expect(() => readKek({ KV_KEK: undefined })).toThrow(/not set/);
    expect(() => readKek({ KV_KEK: "" })).toThrow(/not set/);
  });

  it("should derive the share_U secret name from the assetId (lowercase, no 0x)", () => {
    expect(shareUSecretName(`0x${"AB".repeat(32)}`)).toBe(
      `SHARE_U_${"ab".repeat(32)}`,
    );
    expect(() => shareUSecretName("0x1234" as Hex)).toThrow(/32-byte/);
  });

  it("should read share_U from the per-asset binding and fail closed when absent", () => {
    const name = shareUSecretName(ASSET);
    const shareU = readShareU(
      { ...env, [name]: `0x${"cd".repeat(32)}` },
      ASSET,
    );
    expect(shareU).toHaveLength(32);
    expect(shareU[0]).toBe(0xcd);
    expect(() => readShareU(env, ASSET)).toThrow(new RegExp(name));
  });

  it("should validate RECEIPT_SIGNER_KEY as a 0x-prefixed 32-byte key", () => {
    expect(
      readReceiptSignerKey({ RECEIPT_SIGNER_KEY: `0x${"0f".repeat(32)}` }),
    ).toBe(`0x${"0f".repeat(32)}`);
    expect(() =>
      readReceiptSignerKey({ RECEIPT_SIGNER_KEY: "0f".repeat(32) }),
    ).toThrow(/0x-prefixed/);
    expect(() =>
      readReceiptSignerKey({ RECEIPT_SIGNER_KEY: undefined }),
    ).toThrow(/not set/);
  });

  it("should zero secret bytes on wipe", () => {
    const bytes = readKek({ KV_KEK: `0x${"7f".repeat(32)}` });
    wipe(bytes);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });
});
