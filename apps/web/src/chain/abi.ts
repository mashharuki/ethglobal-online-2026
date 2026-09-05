import { parseAbi } from "viem";

/**
 * The contract surface the browser needs (tasks.md T105): reads that answer "who owns this
 * and in which epoch" straight from Hedera (constitution II), plus the two creator / owner
 * writes (mint, transfer). Human-readable fragments keep the bundle small; the full ABIs live
 * in apps/gateway/src/chain/abi.ts (generated from the contracts build).
 */
export const rightsNftAbi = parseAbi([
  "function mint(address to, address creator, bytes32 policyHash_, bytes32 assetId_, bytes32 contentHash_, string manifestURI_) returns (uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function accessEpoch(uint256 tokenId) view returns (uint256)",
  "function creatorOf(uint256 tokenId) view returns (address)",
  "function assetId(uint256 tokenId) view returns (bytes32)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export const rightsRegistryAbi = parseAbi([
  "function licenseEpoch(uint256 tokenId) view returns (uint256)",
]);
