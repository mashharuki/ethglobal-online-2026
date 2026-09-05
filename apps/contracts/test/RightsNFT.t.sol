// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IRightsNFT} from "../contracts/interfaces/IRightsNFT.sol";
import {RightsNFT} from "../contracts/RightsNFT.sol";

/// @title RightsNFT unit tests (FR-001: accessEpoch is 1 at mint and +1 per transfer, no setter).
contract RightsNFTTest is Test {
    RightsNFT internal nft;
    address internal creator = address(0xC0FFEE);
    address internal ownerA = address(0xA11CE);
    address internal ownerB = address(0xB0B);
    bytes32 internal constant POLICY = bytes32(uint256(0xdddd));

    function setUp() public {
        nft = new RightsNFT();
    }

    function test_MintSetsEpochOneAndMetadata() public {
        uint256 tokenId = nft.mint(ownerA, creator, POLICY, "ipfs://manifest");
        assertEq(tokenId, 1);
        assertEq(nft.ownerOf(tokenId), ownerA);
        assertEq(nft.accessEpoch(tokenId), 1);
        assertEq(nft.creatorOf(tokenId), creator);
        assertEq(nft.policyHash(tokenId), POLICY);
        assertEq(nft.manifestURI(tokenId), "ipfs://manifest");
        assertEq(nft.tokenURI(tokenId), "ipfs://manifest");
    }

    function test_TransferBumpsEpochByOne() public {
        uint256 tokenId = nft.mint(ownerA, creator, POLICY, "ipfs://m");
        vm.prank(ownerA);
        nft.transferFrom(ownerA, ownerB, tokenId);
        assertEq(nft.ownerOf(tokenId), ownerB);
        assertEq(nft.accessEpoch(tokenId), 2);
        vm.prank(ownerB);
        nft.transferFrom(ownerB, ownerA, tokenId);
        assertEq(nft.accessEpoch(tokenId), 3);
    }

    function testFuzz_EpochIsMonotonicAcrossTransfers(uint8 hops) public {
        uint256 tokenId = nft.mint(ownerA, creator, POLICY, "ipfs://m");
        address current = ownerA;
        for (uint8 i = 0; i < hops; i++) {
            address next = i % 2 == 0 ? ownerB : ownerA;
            uint256 before = nft.accessEpoch(tokenId);
            vm.prank(current);
            nft.transferFrom(current, next, tokenId);
            assertEq(nft.accessEpoch(tokenId), before + 1);
            current = next;
        }
        assertEq(nft.accessEpoch(tokenId), uint256(hops) + 1);
    }

    function test_SelfTransferStillBumpsEpoch() public {
        uint256 tokenId = nft.mint(ownerA, creator, POLICY, "ipfs://m");
        vm.prank(ownerA);
        nft.transferFrom(ownerA, ownerA, tokenId);
        assertEq(nft.accessEpoch(tokenId), 2);
    }

    function test_SetPolicyOnlyCreatorAndDoesNotTouchEpoch() public {
        uint256 tokenId = nft.mint(ownerA, creator, POLICY, "ipfs://m");
        vm.prank(ownerA);
        vm.expectRevert(IRightsNFT.NotCreator.selector);
        nft.setPolicy(tokenId, bytes32(uint256(1)), "ipfs://new");

        vm.prank(creator);
        vm.expectEmit(true, false, false, true);
        emit IRightsNFT.PolicyUpdated(tokenId, POLICY, bytes32(uint256(1)));
        nft.setPolicy(tokenId, bytes32(uint256(1)), "ipfs://new");
        assertEq(nft.policyHash(tokenId), bytes32(uint256(1)));
        assertEq(nft.manifestURI(tokenId), "ipfs://new");
        assertEq(nft.accessEpoch(tokenId), 1);
    }

    function test_ViewsRevertForNonexistentToken() public {
        vm.expectRevert(IRightsNFT.NonexistentToken.selector);
        nft.accessEpoch(42);
        vm.expectRevert(IRightsNFT.NonexistentToken.selector);
        nft.creatorOf(42);
        vm.expectRevert(IRightsNFT.NonexistentToken.selector);
        nft.policyHash(42);
        vm.expectRevert(IRightsNFT.NonexistentToken.selector);
        nft.manifestURI(42);
    }

    function test_MintRejectsZeroCreator() public {
        vm.expectRevert(IRightsNFT.NotCreator.selector);
        nft.mint(ownerA, address(0), POLICY, "ipfs://m");
    }

    function test_NonOwnerCannotTransfer() public {
        uint256 tokenId = nft.mint(ownerA, creator, POLICY, "ipfs://m");
        vm.prank(ownerB);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, ownerB, tokenId));
        nft.transferFrom(ownerA, ownerB, tokenId);
        assertEq(nft.accessEpoch(tokenId), 1);
    }

    function test_SupportsRightsNftInterface() public view {
        assertTrue(nft.supportsInterface(type(IRightsNFT).interfaceId));
        assertTrue(nft.supportsInterface(0x80ac58cd)); // ERC-721
    }
}
