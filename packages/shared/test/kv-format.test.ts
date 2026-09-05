import { describe, expect, it } from "vitest";
import {
  decryptShareG,
  encryptShareG,
  KV_FORMAT_VERSION,
  KvFormatError,
} from "../src/kv-format";

const kek = new Uint8Array(32).map((_, i) => i);
const otherKek = new Uint8Array(32).map((_, i) => 255 - i);
const shareG = new Uint8Array(32).map((_, i) => (i * 7) % 256);

describe("share_G KV format", () => {
  it("should round-trip with the version prefix", async () => {
    const blob = await encryptShareG(shareG, kek);
    expect(blob.startsWith(`${KV_FORMAT_VERSION}:`)).toBe(true);
    expect(blob.split(":")).toHaveLength(3);
    expect(await decryptShareG(blob, kek)).toEqual(shareG);
  });

  it("should use a fresh IV per encryption", async () => {
    const a = await encryptShareG(shareG, kek);
    const b = await encryptShareG(shareG, kek);
    expect(a).not.toBe(b);
  });

  it("should reject tampered ciphertext (positive control for authentication)", async () => {
    const blob = await encryptShareG(shareG, kek);
    const parts = blob.split(":");
    const ct = parts[2] ?? "";
    const flipped = ct.slice(0, 2) + (ct[2] === "0" ? "1" : "0") + ct.slice(3);
    await expect(
      decryptShareG(`${parts[0]}:${parts[1]}:${flipped}`, kek),
    ).rejects.toBeInstanceOf(KvFormatError);
  });

  it("should reject the wrong KEK and malformed / unversioned blobs", async () => {
    const blob = await encryptShareG(shareG, kek);
    await expect(decryptShareG(blob, otherKek)).rejects.toBeInstanceOf(
      KvFormatError,
    );
    await expect(decryptShareG("tc-kv-v0:00:00", kek)).rejects.toBeInstanceOf(
      KvFormatError,
    );
    await expect(decryptShareG("garbage", kek)).rejects.toBeInstanceOf(
      KvFormatError,
    );
    await expect(encryptShareG(shareG, new Uint8Array(16))).rejects.toThrow(
      RangeError,
    );
  });
});
