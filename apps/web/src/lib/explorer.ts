const HASHSCAN_TESTNET_BASE = "https://hashscan.io/testnet";

/**
 * True for a 20-byte 0x-prefixed EVM address - distinguishes wallet/contract addresses from
 * 32-byte hashes (receiptHash, assetId) that HashScan's /address route can't resolve.
 */
export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function hashscanAddressUrl(address: string): string {
  return `${HASHSCAN_TESTNET_BASE}/address/${address}`;
}

export function hashscanTxUrl(hash: string): string {
  return `${HASHSCAN_TESTNET_BASE}/transaction/${hash}`;
}
