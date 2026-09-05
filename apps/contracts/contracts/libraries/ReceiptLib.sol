// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IRightsRegistry} from "../interfaces/IRightsRegistry.sol";

/// @title ReceiptLib - EIP-712 hashStruct(RightsReceipt) and policy re-derivation (R-6 / R-6a).
/// @dev MUST stay byte-for-byte compatible with packages/shared/src/eip712.ts and hashing.ts.
///      The golden test (test/ReceiptLib.golden.t.sol) pins the TypeScript values.
library ReceiptLib {
    /// @dev keccak256("RightsReceipt(uint256 chainId,address verifyingContract,address nftContract,
    ///      uint256 tokenId,bytes32 resourceHash,bytes32 policyHash,uint256 licenseEpoch,
    ///      uint256 ownerEpochAtIssue,address licensee,uint8 permittedAction,uint8 transferMode,
    ///      uint32 maxUses,uint64 expiresAt,bytes32 purchaseRequestHash,bytes32 paymentId,
    ///      bytes32 nonce,uint64 issuedAt)")
    bytes32 internal constant RIGHTS_RECEIPT_TYPEHASH = keccak256(
        "RightsReceipt(uint256 chainId,address verifyingContract,address nftContract,uint256 tokenId,bytes32 resourceHash,bytes32 policyHash,uint256 licenseEpoch,uint256 ownerEpochAtIssue,address licensee,uint8 permittedAction,uint8 transferMode,uint32 maxUses,uint64 expiresAt,bytes32 purchaseRequestHash,bytes32 paymentId,bytes32 nonce,uint64 issuedAt)"
    );

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant DOMAIN_NAME_HASH = keccak256("TrueCollective");
    bytes32 internal constant DOMAIN_VERSION_HASH = keccak256("1");

    /// @notice EIP-712 hashStruct of the 17-field RightsReceipt. This is `receiptHash`,
    ///         the on-chain authorization key (constitution V).
    function hashStruct(IRightsRegistry.ReceiptParams calldata p, uint256 chainId, address verifyingContract)
        internal
        pure
        returns (bytes32)
    {
        // Split in two abi.encode calls to keep the stack shallow; concatenation of the
        // static words is identical to a single abi.encode(...) of all 18 values.
        bytes memory head = abi.encode(
            RIGHTS_RECEIPT_TYPEHASH,
            chainId,
            verifyingContract,
            p.nftContract,
            p.tokenId,
            p.resourceHash,
            p.policyHash,
            p.licenseEpoch,
            p.ownerEpochAtIssue
        );
        bytes memory tail = abi.encode(
            p.licensee,
            p.permittedAction,
            p.transferMode,
            p.maxUses,
            p.expiresAt,
            p.purchaseRequestHash,
            p.paymentId,
            p.nonce,
            p.issuedAt
        );
        return keccak256(bytes.concat(head, tail));
    }

    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, chainId, verifyingContract)
        );
    }

    /// @notice EIP-712 digest (0x1901 || domainSeparator || hashStruct) for signature verification.
    function digest(bytes32 structHash, uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(chainId, verifyingContract), structHash));
    }

    /// @notice Re-derives policyHash from the receipt's own content (R-6a). Encoding matches
    ///         packages/shared computePolicyHash: (price uint256, duration uint64, maxUses uint32,
    ///         permittedAction uint8, transferMode uint8, creatorBps uint16, ownerBps uint16).
    function policyContentHash(IRightsRegistry.ReceiptParams calldata p) internal pure returns (bytes32) {
        uint64 durationSec = p.expiresAt - p.issuedAt; // reverts on underflow (expiresAt < issuedAt)
        return keccak256(
            abi.encode(p.price, durationSec, p.maxUses, p.permittedAction, p.transferMode, p.creatorBps, p.ownerBps)
        );
    }

    /// @notice Explicit-argument variant so callers (and tests) can hash a policy without a full receipt.
    function policyHashOf(
        uint256 priceTinybar,
        uint64 durationSec,
        uint32 maxUses,
        uint8 permittedAction,
        uint8 transferMode,
        uint16 creatorBps,
        uint16 ownerBps
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(priceTinybar, durationSec, maxUses, permittedAction, transferMode, creatorBps, ownerBps)
        );
    }

    /// @notice keccak256(abi.encode(nftContract, tokenId, assetId, contentHash)) - matches computeResourceHash.
    function resourceHashOf(address nftContract, uint256 tokenId, bytes32 assetId, bytes32 contentHash)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(nftContract, tokenId, assetId, contentHash));
    }

    /// @notice Committed params hash for the R-2a fallback: keccak256(abi.encode(p)) over ALL fields
    ///         (licensee included), so `finalize` can only complete the purchase committed at `payFor`.
    function committedParamsHash(IRightsRegistry.ReceiptParams calldata p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }
}
