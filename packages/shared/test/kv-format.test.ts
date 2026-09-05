import { describe, expect, it } from "vitest";
import {
  decryptShareG,
  encryptShareG,
  KV_FORMAT_VERSION,
  KvFormatError,
  shareGKvKey,
} from "../src/kv-format";

const kek = new Uint8Array(32).map((_, i) => i);
const otherKek = new Uint8Array(32).map((_, i) => 255 - i);
const shareG = new Uint8Array(32).map((_, i) => (i * 7) % 256);
const assetA = `0x${"aa".repeat(32)}` as const;
const assetB = `0x${"ab".repeat(32)}` as const;

describe("share_G KV format", () => {
  it("should round-trip with the version prefix", async () => {
    const blob = await encryptShareG(shareG, kek, assetA);
    expect(blob.startsWith(`${KV_FORMAT_VERSION}:`)).toBe(true);
    expect(blob.split(":")).toHaveLength(3);
    expect(await decryptShareG(blob, kek, assetA)).toEqual(shareG);
  });

  it("should use a fresh IV per encryption", async () => {
    const a = await encryptShareG(shareG, kek, assetA);
    const b = await encryptShareG(shareG, kek, assetA);
    expect(a).not.toBe(b);
  });

  it("should reject tampered ciphertext (positive control for authentication)", async () => {
    const blob = await encryptShareG(shareG, kek, assetA);
    const parts = blob.split(":");
    const ct = parts[2] ?? "";
    const flipped = ct.slice(0, 2) + (ct[2] === "0" ? "1" : "0") + ct.slice(3);
    await expect(
      decryptShareG(`${parts[0]}:${parts[1]}:${flipped}`, kek, assetA),
    ).rejects.toBeInstanceOf(KvFormatError);
  });

  it("should reject a blob substituted from another asset (AAD binds the KV key)", async () => {
    const blobForA = await encryptShareG(shareG, kek, assetA);
    await expect(decryptShareG(blobForA, kek, assetB)).rejects.toBeInstanceOf(
      KvFormatError,
    );
    expect(shareGKvKey(assetA)).not.toBe(shareGKvKey(assetB));
    expect(shareGKvKey(assetA.toUpperCase() as `0x${string}`)).toBe(
      shareGKvKey(assetA),
    );
  });

  it("should reject the wrong KEK and malformed / unversioned blobs", async () => {
    const blob = await encryptShareG(shareG, kek, assetA);
    await expect(decryptShareG(blob, otherKek, assetA)).rejects.toBeInstanceOf(
      KvFormatError,
    );
    await expect(
      decryptShareG("tc-kv-v0:00:00", kek, assetA),
    ).rejects.toBeInstanceOf(KvFormatError);
    await expect(decryptShareG("garbage", kek, assetA)).rejects.toBeInstanceOf(
      KvFormatError,
    );
    await expect(
      encryptShareG(shareG, new Uint8Array(16), assetA),
    ).rejects.toThrow(RangeError);
  });
});
