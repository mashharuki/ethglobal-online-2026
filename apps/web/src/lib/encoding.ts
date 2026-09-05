/**
 * Encodes bytes as standard (non-URL) base64 without depending on Node's Buffer.
 * Works in browsers and in Node 16+ (global `btoa`).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
