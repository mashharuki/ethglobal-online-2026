// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {IRightsRegistry} from "../contracts/interfaces/IRightsRegistry.sol";
import {ReceiptLib} from "../contracts/libraries/ReceiptLib.sol";
import {RightsNFT} from "../contracts/RightsNFT.sol";
import {RightsRegistry} from "../contracts/RightsRegistry.sol";

/// @dev Shared fixture for RightsRegistry suites: one RightsNFT, one registry, a minted asset.
///      No `test*` functions here, so Hardhat does not treat it as a test contract.
abstract contract RegistryTestBase is Test {
    uint8 internal constant SURVIVE = 0;
    uint8 internal constant INVALIDATE = 1;

    bytes32 internal constant ASSET_ID = bytes32(uint256(0xaaaa));
    bytes32 internal constant CONTENT_HASH = bytes32(uint256(0xbbbb));
    uint256 internal constant PRICE = 500_000_000; // 5 HBAR in tinybar
    uint256 internal constant PRICE_WEIBAR = PRICE * 1e10;
    uint64 internal constant DURATION = 300;
    uint32 internal constant MAX_USES = 5;
    uint8 internal constant PERMS = 6;
    uint16 internal constant CREATOR_BPS = 3000;
    uint16 internal constant OWNER_BPS = 7000;
    uint64 internal constant T0 = 1_800_000_000;

    address internal creator = address(0xC0FFEE);
    address internal ownerA = address(0xA11CE);
    address internal ownerB = address(0xB0B);
    address internal buyer = address(0xB0BE2);
    address internal buyer2 = address(0xB0BE3);
    address internal operator = address(0x0BE4A70);
    address internal admin = address(0xAD1);
    address internal stranger = address(0x5714);

    RightsNFT internal nft;
    RightsRegistry internal reg;
    uint256 internal tokenId;

    function setUp() public virtual {
        vm.warp(T0);
        nft = new RightsNFT();
        reg = new RightsRegistry(nft, admin, operator);
        tokenId = _mintAsset(SURVIVE);
        vm.deal(buyer, 1000 ether);
        vm.deal(buyer2, 1000 ether);
    }

    function _policyHash(uint8 mode) internal pure returns (bytes32) {
        return ReceiptLib.policyHashOf(PRICE, DURATION, MAX_USES, PERMS, mode, CREATOR_BPS, OWNER_BPS);
    }

    function _mintAsset(uint8 mode) internal returns (uint256 id) {
        vm.prank(creator);
        id = nft.mint(ownerA, creator, _policyHash(mode), ASSET_ID, CONTENT_HASH, "ipfs://manifest");
    }

    /// @dev Builds consistent ReceiptParams for `id` as seen by an honest gateway right now.
    function _params(uint256 id, address licensee, uint8 mode, bytes32 paymentId, bytes32 nonce)
        internal
        view
        returns (IRightsRegistry.ReceiptParams memory p)
    {
        p.nftContract = address(nft);
        p.tokenId = id;
        p.resourceHash = nft.resourceHash(id);
        p.policyHash = nft.policyHash(id);
        p.licenseEpoch = reg.licenseEpoch(id);
        p.ownerEpochAtIssue = nft.accessEpoch(id);
        p.licensee = licensee;
        p.permittedAction = PERMS;
        p.transferMode = mode;
        p.maxUses = MAX_USES;
        p.issuedAt = uint64(block.timestamp);
        p.expiresAt = p.issuedAt + DURATION;
        p.purchaseRequestHash = keccak256(abi.encode("POST", "/assets/a/paid", paymentId));
        p.paymentId = paymentId;
        p.nonce = nonce;
        p.price = PRICE;
        p.creatorBps = CREATOR_BPS;
        p.ownerBps = OWNER_BPS;
    }

    function _params(address licensee, bytes32 salt) internal view returns (IRightsRegistry.ReceiptParams memory) {
        return _params(
            tokenId, licensee, SURVIVE, keccak256(abi.encode("pay", salt)), keccak256(abi.encode("nonce", salt))
        );
    }

    function _settleAs(address payer, IRightsRegistry.ReceiptParams memory p) internal returns (bytes32) {
        vm.prank(payer);
        return reg.settleAndIssue{value: PRICE_WEIBAR}(p);
    }

    function _expectedHash(IRightsRegistry.ReceiptParams memory p) internal view returns (bytes32) {
        return _hashExternal(p);
    }

    /// @dev Route through an external call so the library can take calldata.
    function _hashExternal(IRightsRegistry.ReceiptParams memory p) internal view returns (bytes32) {
        return this.hashParams(p, block.chainid, address(reg));
    }

    function hashParams(IRightsRegistry.ReceiptParams calldata p, uint256 chainId, address verifyingContract)
        external
        pure
        returns (bytes32)
    {
        return ReceiptLib.hashStruct(p, chainId, verifyingContract);
    }

    function committedHash(IRightsRegistry.ReceiptParams calldata p) external pure returns (bytes32) {
        return ReceiptLib.committedParamsHash(p);
    }

    function _consume(bytes32 receiptHash, uint32 useIndex) internal {
        vm.prank(operator);
        reg.consume(receiptHash, useIndex);
    }

    function _transfer(address from, address to) internal {
        vm.prank(from);
        nft.transferFrom(from, to, tokenId);
    }
}
