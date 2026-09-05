import {
  buildDomain,
  keyGateTypedData,
  licenseeAuthTypedData,
  recoverContentKey,
  unblindShareU,
} from "@truenft/shared";
import { type Hex, hexToBytes, keccak256 } from "viem";
import { issueNonce, toUnixSeconds } from "../../auth/nonce";
import { decryptWithKey } from "../../keygate/fallback";
import { releaseToLicensee } from "../../keygate/release";
import { wipe } from "../../keygate/vault";
import type { McpContext } from "../context";
import { assertReceiptBoundToSession, requireSession } from "../session";
import { McpToolError } from "../toolError";

/**
 * `decrypt_content` (tasks.md T095, mcp-tools.md): the licensee KeyGate path with the MCP
 * server acting as the client. Order matters:
 *   0. the receipt must have been bought from this Mcp-Session-Id (R-9a)
 *   1. the agent wallet signs LicenseeAuthChallenge (auth) and KeyGateChallenge (key material)
 *   2. releaseToLicensee: chain re-read, ReceiptLock consume, share_G + blindedU
 *   3. K = share_G XOR unblind(blindedU) in this process, ciphertext fetched + hash-checked
 *   4. plaintext returned; every key byte wiped
 * The Privy wallet signs deterministically (RFC 6979), so the KeyGateChallenge signature -
 * and with it blindedU - is stable across calls; a mismatch surfaces as a GCM auth failure.
 */
export type DecryptContentOutput = {
  useIndex: number;
  onchainTx: string;
  dataset: { format: "json" | "csv" | "text" | "base64"; content: string };
};

function describe(plaintext: Uint8Array): DecryptContentOutput["dataset"] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      plaintext,
    );
  } catch {
    let binary = "";
    for (const byte of plaintext) binary += String.fromCharCode(byte);
    return { format: "base64", content: btoa(binary) };
  }
  try {
    JSON.parse(text);
    return { format: "json", content: text };
  } catch {
    // not JSON
  }
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.includes(",")) return { format: "csv", content: text };
  return { format: "text", content: text };
}

export async function decryptContent(
  ctx: McpContext,
  input: { assetId: Hex; receiptHash: Hex },
): Promise<DecryptContentOutput> {
  const sessionId = requireSession(ctx.sessionId);
  const { services } = ctx;
  await assertReceiptBoundToSession(services.db, input.receiptHash, sessionId);

  const wallet = services.agent.wallet();
  const { deployment } = services.release;
  const domain = buildDomain(deployment.rightsRegistry, deployment.chainId);
  const issued = await issueNonce(services.db, {
    wallet: wallet.address,
    purpose: "keygate-challenge",
    chainId: deployment.chainId,
    now: services.now(),
  });
  const authSig = await wallet.signTypedData(
    licenseeAuthTypedData(domain, {
      nonce: issued.nonce,
      chainId: BigInt(deployment.chainId),
      receiptHash: input.receiptHash,
      expiresAt: toUnixSeconds(issued.expiresAt),
    }),
  );
  const keyGateSig = await wallet.signTypedData(
    keyGateTypedData(domain, {
      assetId: input.assetId,
      purpose: "licensee",
      receiptHash: input.receiptHash,
    }),
  );
  const released = await releaseToLicensee(services.release, {
    assetId: input.assetId,
    receiptHash: input.receiptHash,
    authSig,
    keyGateSig,
  });

  const ciphertext = await services.fetchBytes(released.encryptedContentURI);
  if (keccak256(ciphertext) !== released.contentHash) {
    throw new McpToolError(
      "CONTENT_HASH_MISMATCH",
      "encrypted content does not match the manifest contentHash",
    );
  }
  const shareU = await unblindShareU(
    hexToBytes(released.blindedU),
    keyGateSig,
    input.assetId,
  );
  const shareG = hexToBytes(released.shareG);
  const key = recoverContentKey(shareG, shareU);
  wipe(shareG);
  wipe(shareU);
  try {
    const plaintext = await decryptWithKey(key, ciphertext);
    return {
      useIndex: released.useIndex,
      onchainTx: released.onchainTx,
      dataset: describe(plaintext),
    };
  } finally {
    wipe(key);
  }
}
