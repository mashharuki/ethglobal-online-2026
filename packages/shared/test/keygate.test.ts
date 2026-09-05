import { hkdfSync, randomBytes } from "node:crypto";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { buildDomain, deriveShareUInfo, keyGateTypedData } from "../src/index";
import {
  blindShareU,
  deriveBlindingMask,
  recoverContentKey,
  unblindShareU,
  xorBytes,
} from "../src/keygate";

const ASSET = `0x${"a7".repeat(32)}` as Hex;
const REGISTRY = "0x1111111111111111111111111111111111111111";
const wallet = privateKeyToAccount(`0x${"42".repeat(32)}`);

async function keyGateSig(): Promise<Hex> {
  return wallet.signTypedData(
    keyGateTypedData(buildDomain(REGISTRY), {
      assetId: ASSET,
      purpose: "owner",
      receiptHash: `0x${"00".repeat(32)}`,
    }),
  );
}

describe("KeyGate share arithmetic (R-1 / R-1a)", () => {
  it("should derive the HKDF mask exactly like an independent implementation (node hkdfSync)", async () => {
    const sig = await keyGateSig();
    const expected = new Uint8Array(
      hkdfSync(
        "sha256",
        Buffer.from(hexToBytes(sig)),
        Buffer.alloc(0),
        Buffer.from(`truenft/keygate/v1/0x${"a7".repeat(32)}`, "utf8"), // literal protocol info, not the production helper
        32,
      ),
    );
    expect(await deriveBlindingMask(sig, ASSET)).toEqual(expected);
  });

  it("should build the info string the client will use", () => {
    expect(deriveShareUInfo(ASSET)).toBe(
      `truenft/keygate/v1/0x${"a7".repeat(32)}`,
    );
  });

  it("should be deterministic for the same wallet + asset (fixed challenge => stable share_U')", async () => {
    const a = await deriveBlindingMask(await keyGateSig(), ASSET);
    const b = await deriveBlindingMask(await keyGateSig(), ASSET);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it("should change the mask when the asset changes (info binding)", async () => {
    const sig = await keyGateSig();
    const other = `0x${"b8".repeat(32)}` as Hex;
    expect(bytesToHex(await deriveBlindingMask(sig, ASSET))).not.toBe(
      bytesToHex(await deriveBlindingMask(sig, other)),
    );
  });

  it("should round-trip: blind on the gateway, unblind on the client, recover K", async () => {
    const sig = await keyGateSig();
    const k = new Uint8Array(randomBytes(32));
    const shareG = new Uint8Array(randomBytes(32));
    const shareU = xorBytes(k, shareG);
    const blinded = await blindShareU(shareU, sig, ASSET);
    expect(bytesToHex(blinded)).not.toBe(bytesToHex(shareU));
    const recoveredU = await unblindShareU(blinded, sig, ASSET);
    expect(recoveredU).toEqual(shareU);
    expect(recoverContentKey(shareG, recoveredU)).toEqual(k);
  });

  it("should not recover K with another wallet's signature", async () => {
    const sig = await keyGateSig();
    const stranger = privateKeyToAccount(`0x${"43".repeat(32)}`);
    const strangerSig = await stranger.signTypedData(
      keyGateTypedData(buildDomain(REGISTRY), {
        assetId: ASSET,
        purpose: "owner",
        receiptHash: `0x${"00".repeat(32)}`,
      }),
    );
    const k = new Uint8Array(randomBytes(32));
    const shareG = new Uint8Array(randomBytes(32));
    const blinded = await blindShareU(xorBytes(k, shareG), sig, ASSET);
    const wrongU = await unblindShareU(blinded, strangerSig, ASSET);
    expect(recoverContentKey(shareG, wrongU)).not.toEqual(k);
  });

  it("should reject malformed inputs", async () => {
    await expect(deriveBlindingMask("0x1234", ASSET)).rejects.toThrow(
      /65-byte/,
    );
    await expect(
      blindShareU(new Uint8Array(31), await keyGateSig(), ASSET),
    ).rejects.toThrow(/32 bytes/);
    expect(() => xorBytes(new Uint8Array(2), new Uint8Array(3))).toThrow(
      /length/,
    );
  });
});
