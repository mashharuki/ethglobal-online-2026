// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title IRightsNFT - ERC-721 with an Owner Epoch (`accessEpoch`) per token.
/// @notice `accessEpoch` is bumped ONLY inside `_update` on every real transfer (FR-001).
///         There is no external setter by design (constitution I).
///         Spec: specs/001-rights-runtime-mvp/contracts/solidity-interfaces.md
interface IRightsNFT is IERC721 {
    // ---- views (the Gateway / KeyGate eth_call these; constitution II) ----

    /// @notice Owner Epoch. 1 at mint, +1 on every transfer between non-zero addresses.
    function accessEpoch(uint256 tokenId) external view returns (uint256);

    function creatorOf(uint256 tokenId) external view returns (address);

    function policyHash(uint256 tokenId) external view returns (bytes32);

    function manifestURI(uint256 tokenId) external view returns (string memory);

    /// @notice Immutable content binding fixed at mint (FR-015: the ciphertext never changes).
    function assetId(uint256 tokenId) external view returns (bytes32);

    function contentHash(uint256 tokenId) external view returns (bytes32);

    /// @notice keccak256(abi.encode(address(this), tokenId, assetId, contentHash)) - R-6 resourceHash,
    ///         recomputed on-chain so RightsRegistry can reject cross-resource receipts.
    function resourceHash(uint256 tokenId) external view returns (bytes32);

    // ---- writes ----

    /// @notice `creator` must be msg.sender. `assetId` / `contentHash` are fixed for the token's life.
    function mint(
        address to,
        address creator,
        bytes32 policyHash_,
        bytes32 assetId_,
        bytes32 contentHash_,
        string calldata manifestURI_
    ) external returns (uint256 tokenId);

    /// @notice Creator only. Does NOT bump the License Epoch (that lives in RightsRegistry).
    function setPolicy(uint256 tokenId, bytes32 newPolicyHash, string calldata newManifestURI) external;

    // ---- events (Transfer is the ERC-721 standard event) ----

    event PolicyUpdated(uint256 indexed tokenId, bytes32 oldPolicyHash, bytes32 newPolicyHash);

    // ---- errors ----

    error NotCreator();
    error NonexistentToken();
}
