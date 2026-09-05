// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IRightsNFT} from "./interfaces/IRightsNFT.sol";

/// @title RightsNFT - ERC-721 whose Owner Epoch (`accessEpoch`) advances on every transfer.
/// @notice The ONLY place `_accessEpoch` is written is `_update` (constitution I / FR-001).
///         Policy changes (`setPolicy`) never touch the License Epoch; that counter lives in
///         RightsRegistry and only moves on `bumpLicenseEpoch`.
contract RightsNFT is ERC721, IRightsNFT {
    uint256 private _nextTokenId = 1;

    mapping(uint256 tokenId => uint256) private _accessEpoch;
    mapping(uint256 tokenId => address) private _creator;
    mapping(uint256 tokenId => bytes32) private _policyHash;
    mapping(uint256 tokenId => string) private _manifestURI;

    constructor() ERC721("TrueCollective Rights", "TCR") {}

    // ---------------------------------------------------------------- views

    function accessEpoch(uint256 tokenId) external view returns (uint256) {
        _requireExists(tokenId);
        return _accessEpoch[tokenId];
    }

    function creatorOf(uint256 tokenId) external view returns (address) {
        _requireExists(tokenId);
        return _creator[tokenId];
    }

    function policyHash(uint256 tokenId) external view returns (bytes32) {
        _requireExists(tokenId);
        return _policyHash[tokenId];
    }

    function manifestURI(uint256 tokenId) external view returns (string memory) {
        _requireExists(tokenId);
        return _manifestURI[tokenId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireExists(tokenId);
        return _manifestURI[tokenId];
    }

    // --------------------------------------------------------------- writes

    function mint(address to, address creator, bytes32 policyHash_, string calldata manifestURI_)
        external
        returns (uint256 tokenId)
    {
        if (creator == address(0)) revert NotCreator();
        tokenId = _nextTokenId++;
        _creator[tokenId] = creator;
        _policyHash[tokenId] = policyHash_;
        _manifestURI[tokenId] = manifestURI_;
        _accessEpoch[tokenId] = 1;
        _safeMint(to, tokenId);
    }

    function setPolicy(uint256 tokenId, bytes32 newPolicyHash, string calldata newManifestURI) external {
        _requireExists(tokenId);
        if (msg.sender != _creator[tokenId]) revert NotCreator();
        bytes32 old = _policyHash[tokenId];
        _policyHash[tokenId] = newPolicyHash;
        _manifestURI[tokenId] = newManifestURI;
        emit PolicyUpdated(tokenId, old, newPolicyHash);
    }

    // ------------------------------------------------------------- internal

    /// @dev Sole writer of `_accessEpoch` after mint: +1 on every real transfer.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0)) {
            _accessEpoch[tokenId] += 1;
        }
    }

    function _requireExists(uint256 tokenId) private view {
        if (_ownerOf(tokenId) == address(0)) revert NonexistentToken();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, IERC165) returns (bool) {
        return interfaceId == type(IRightsNFT).interfaceId || super.supportsInterface(interfaceId);
    }
}
