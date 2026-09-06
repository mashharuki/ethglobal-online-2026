import {
  type Address,
  encodeAbiParameters,
  type Hex,
  keccak256,
  stringToHex,
} from "viem";

/**
 * Hash normalization (research.md R-6). Every layer must produce the same values;
 * the Solidity side re-implements these in ReceiptLib / RightsRegistry and the golden
 * tests pin them.
 */

export const TINYBAR_PER_HBAR = 100_000_000n;
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;
export const WEIBAR_PER_HBAR = TINYBAR_PER_HBAR * WEIBAR_PER_TINYBAR;
export const UINT256_MAX = (1n << 256n) - 1n;

/** True when `value` is a decimal integer string that fits in uint256 (ABI-encodable). */
export function isUint256Decimal(value: string): boolean {
  if (!/^[0-9]+$/.test(value)) return false;
  return BigInt(value) <= UINT256_MAX;
}

/** `transferMode` uint8 encoding used on-chain and in the EIP-712 struct. */
export const TransferMode = {
  SURVIVE_TRANSFER: 0,
  INVALIDATE_ON_TRANSFER: 1,
} as const;
export type TransferModeName = keyof typeof TransferMode;
export type TransferModeValue = (typeof TransferMode)[TransferModeName];

/** permittedAction bit flags (eip712-types.md). */
export const PermissionBit = {
  commercialUse: 1 << 0,
  aiTraining: 1 << 1,
  derivativeGeneration: 1 << 2,
} as const;

export type Permissions = {
  commercialUse: boolean;
  aiTraining: boolean;
  derivativeGeneration: boolean;
};

export function permissionsToBitflags(permissions: Permissions): number {
  let flags = 0;
  if (permissions.commercialUse) flags |= PermissionBit.commercialUse;
  if (permissions.aiTraining) flags |= PermissionBit.aiTraining;
  if (permissions.derivativeGeneration)
    flags |= PermissionBit.derivativeGeneration;
  return flags;
}

export function bitflagsToPermissions(flags: number): Permissions {
  return {
    commercialUse: (flags & PermissionBit.commercialUse) !== 0,
    aiTraining: (flags & PermissionBit.aiTraining) !== 0,
    derivativeGeneration: (flags & PermissionBit.derivativeGeneration) !== 0,
  };
}

/** Manifest prices are weibar strings; contract accounting is tinybar (R-4). */
export function weibarToTinybar(weibar: bigint): bigint {
  if (weibar < 0n) throw new RangeError("weibar must be non-negative");
  if (weibar % WEIBAR_PER_TINYBAR !== 0n) {
    throw new RangeError(
      "weibar amount must be a multiple of 1e10 (tinybar precision)",
    );
  }
  return weibar / WEIBAR_PER_TINYBAR;
}

export function tinybarToWeibar(tinybar: bigint): bigint {
  if (tinybar < 0n) throw new RangeError("tinybar must be non-negative");
  return tinybar * WEIBAR_PER_TINYBAR;
}

export type ResourceHashInput = {
  nftContract: Address;
  tokenId: bigint;
  assetId: Hex;
  contentHash: Hex;
};

/** keccak256(abi.encode(nftContract, tokenId, assetId, contentHash)) */
export function computeResourceHash(input: ResourceHashInput): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [input.nftContract, input.tokenId, input.assetId, input.contentHash],
    ),
  );
}

export type PolicyHashInput = {
  /** tinybar (Manifest weibar / 1e10) */
  priceTinybar: bigint;
  durationSec: bigint;
  maxUses: number;
  permittedAction: number;
  transferMode: TransferModeValue;
  creatorBps: number;
  ownerBps: number;
};

/**
 * keccak256(abi.encode(price uint256, duration uint64, maxUses uint32, permissions uint8,
 * transferMode uint8, creatorBps uint16, ownerBps uint16)). Same encoding is re-derived by
 * `settleAndIssue` (R-6a) with `duration = expiresAt - issuedAt`.
 */
export function computePolicyHash(input: PolicyHashInput): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint32" },
        { type: "uint8" },
        { type: "uint8" },
        { type: "uint16" },
        { type: "uint16" },
      ],
      [
        input.priceTinybar,
        input.durationSec,
        input.maxUses,
        input.permittedAction,
        input.transferMode,
        input.creatorBps,
        input.ownerBps,
      ],
    ),
  );
}

/**
 * Digest of a KeyGate condition expression (full keccak256 of its UTF-8 text). A full
 * 32-byte digest is used rather than a 4-byte selector so conditionsHash keeps
 * collision resistance for arbitrary expressions.
 */
export function conditionDigest(condition: string): Hex {
  return keccak256(stringToHex(condition));
}

export type ConditionsHashInput = {
  ownerCondition: string;
  licenseCondition: string;
  verifyingContract: Address;
};

/** keccak256(abi.encode(ownerConditionDigest bytes32, licenseConditionDigest bytes32, verifyingContract)) */
export function computeConditionsHash(input: ConditionsHashInput): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
      [
        conditionDigest(input.ownerCondition),
        conditionDigest(input.licenseCondition),
        input.verifyingContract,
      ],
    ),
  );
}

/** Locale-independent code-unit ordering (hash preimages must not depend on ICU collation). */
function ordinalCompare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * canonicalPath: lower-case, no trailing slash (except "/"), query keys sorted,
 * fragment dropped. Only the path + query participate in purchaseRequestHash.
 */
export function canonicalPath(rawPath: string): string {
  const withoutFragment = rawPath.split("#", 1)[0] ?? "";
  const [pathPart = "", ...queryParts] = withoutFragment.split("?");
  let path = pathPart.toLowerCase();
  if (!path.startsWith("/")) path = `/${path}`;
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const query = queryParts.join("?");
  if (query === "") return path;
  const pairs = query
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const [key = "", ...rest] = pair.split("=");
      return [key.toLowerCase(), rest.join("=")] as const;
    })
    // Values break ties between repeated query keys so reordered pairs hash identically.
    .sort(([a, av], [b, bv]) => ordinalCompare(a, b) || ordinalCompare(av, bv));
  return `${path}?${pairs.map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join("&")}`;
}

export type PurchaseRequestHashInput = {
  httpMethod: string;
  /** Already canonicalized (see canonicalPath) or raw; it is canonicalized again here. */
  path: string;
  planId: Hex;
  resourceHash: Hex;
  policyHash: Hex;
};

/**
 * keccak256(abi.encode(httpMethod, canonicalPath, planId, resourceHash, policyHash)).
 * MUST NOT include the body of individual access (decrypt) calls (constitution V).
 */
export function computePurchaseRequestHash(
  input: PurchaseRequestHashInput,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "string" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        input.httpMethod.toUpperCase(),
        canonicalPath(input.path),
        input.planId,
        input.resourceHash,
        input.policyHash,
      ],
    ),
  );
}
