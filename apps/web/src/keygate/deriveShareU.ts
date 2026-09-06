import { unblindShareU } from "@truenft/shared";
import { type Hex, hexToBytes } from "viem";

/**
 * Client side of the KeyGate (tasks.md T107, research.md R-1): the gateway only ever hands out
 * `blindedU = share_U XOR HKDF(keyGateSig)`; the wallet's KeyGateChallenge signature is the key
 * material that unblinds it here, in the browser. The gateway never sees share_U'.
 */
export async function deriveShareU(input: {
  blindedU: Hex;
  keyGateSig: Hex;
  assetId: Hex;
}): Promise<Uint8Array> {
  return unblindShareU(
    hexToBytes(input.blindedU),
    input.keyGateSig,
    input.assetId,
  );
}
