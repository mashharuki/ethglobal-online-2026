import { blindShareU } from "@truenft/shared";
import { bytesToHex, type Hex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { encryptDataset, splitKey } from "../creator/prepare";
import {
  ContentHashMismatchError,
  contentHttpUrl,
  decryptContent,
  describeDataset,
} from "./decrypt";
import { deriveShareU } from "./deriveShareU";

const ASSET_ID = `0x${"a5".repeat(32)}` as Hex;
const wallet = privateKeyToAccount(`0x${"b7".repeat(32)}`);

/** Creator encrypts + splits; gateway blinds share_U with the wallet's KeyGate signature. */
async function publish(plaintext: string) {
  const { key, blob } = await encryptDataset(
    new TextEncoder().encode(plaintext),
  );
  const { shareG, shareU } = splitKey(key);
  const keyGateSig = await wallet.signMessage({ message: "keygate" });
  const blindedU = await blindShareU(shareU, keyGateSig, ASSET_ID);
  return {
    blob,
    contentHash: keccak256(blob),
    shareG: bytesToHex(shareG),
    blindedU: bytesToHex(blindedU),
    keyGateSig,
  };
}

describe("KeyGate client side (T107)", () => {
  it("should unblind share_U with the signature and recover the plaintext", async () => {
    const published = await publish("region,mrr\nEU,1200\n");
    const shareU = await deriveShareU({
      blindedU: published.blindedU as Hex,
      keyGateSig: published.keyGateSig,
      assetId: ASSET_ID,
    });
    const dataset = await decryptContent({
      shareG: published.shareG as Hex,
      shareU,
      ciphertext: published.blob,
      contentHash: published.contentHash,
    });
    expect(dataset).toMatchObject({
      format: "csv",
      text: "region,mrr\nEU,1200\n",
    });
  });

  it("should fail with a different signature (wrong key material) and on a tampered blob", async () => {
    const published = await publish("hello");
    const otherSig = await wallet.signMessage({ message: "not the keygate" });
    const wrongShareU = await deriveShareU({
      blindedU: published.blindedU as Hex,
      keyGateSig: otherSig,
      assetId: ASSET_ID,
    });
    await expect(
      decryptContent({
        shareG: published.shareG as Hex,
        shareU: wrongShareU,
        ciphertext: published.blob,
        contentHash: published.contentHash,
      }),
    ).rejects.toThrow();
    const tampered = new Uint8Array(published.blob);
    tampered[tampered.length - 1] ^= 1;
    await expect(
      decryptContent({
        shareG: published.shareG as Hex,
        shareU: wrongShareU,
        ciphertext: tampered,
        contentHash: published.contentHash,
      }),
    ).rejects.toBeInstanceOf(ContentHashMismatchError);
  });

  it("should classify datasets and map ipfs URIs to the gateway", () => {
    expect(describeDataset(new TextEncoder().encode('{"a":1}')).format).toBe(
      "json",
    );
    expect(describeDataset(new TextEncoder().encode("a,b\n1,2")).format).toBe(
      "csv",
    );
    expect(describeDataset(new TextEncoder().encode("plain")).format).toBe(
      "text",
    );
    expect(describeDataset(new Uint8Array([0xff, 0xfe, 0x00])).format).toBe(
      "binary",
    );
    expect(contentHttpUrl("ipfs://bafy/x.enc", "https://ipfs.io/")).toBe(
      "https://ipfs.io/ipfs/bafy/x.enc",
    );
    expect(contentHttpUrl("https://cdn/x", "https://ipfs.io")).toBe(
      "https://cdn/x",
    );
  });
});
