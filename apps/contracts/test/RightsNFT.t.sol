// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IRightsNFT} from "../contracts/interfaces/IRightsNFT.sol";
import {RightsNFT} from "../contracts/RightsNFT.sol";

/// @dev Receiver that records the epoch visible inside onERC721Received and optionally rejects.
contract EpochObservingReceiver is IERC721Receiver {
    RightsNFT internal immutable nft;
    bool internal reject;
    uint256 public observedEpoch;

    constructor(RightsNFT nft_, bool reject_) {
        nft = nft_;
        reject = reject_;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        observedEpoch = nft.accessEpoch(tokenId);
        if (reject) revert("receiver rejects");
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @title RightsNFT unit tests (FR-001: accessEpoch is 1 at mint and +1 per transfer, no setter).
contract RightsNFTTest is Test {
    RightsNFT internal nft;
    address internal creator = address(0xC0FFEE);
    address internal ownerA = address(0xA11CE);
    address internal ownerB = address(0xB0B);
    address internal operator = address(0x0BE4A70);
    bytes32 internal constant POLICY = bytes32(uint256(0xdddd));

    function setUp() public {
        nft = new RightsNFT();
    }

    /// @dev The creator mints (msg.sender == creator) to the first owner.
    bytes32 internal constant ASSET_ID = bytes32(uint256(0xaaaa));
    bytes32 internal constant CONTENT_HASH = bytes32(uint256(0xbbbb));

    function _mint(string memory uri) internal returns (uint256 tokenId) {
        vm.prank(creator);
        tokenId = nft.mint(ownerA, creator, POLICY, ASSET_ID, CONTENT_HASH, uri);
    }

    function test_ResourceHashIsBoundToContractTokenAssetAndContent() public {
        uint256 tokenId = _mint("ipfs://m");
        assertEq(nft.assetId(tokenId), ASSET_ID);
        assertEq(nft.contentHash(tokenId), CONTENT_HASH);
        assertEq(nft.resourceHash(tokenId), keccak256(abi.encode(address(nft), tokenId, ASSET_ID, CONTENT_HASH)));
        vm.expectRevert(IRightsNFT.NonexistentToken.selector);
        nft.resourceHash(42);
    }

    function test_MintSetsEpochOneAndMetadata() public {
        uint256 tokenId = _mint("ipfs://manifest");
        assertEq(tokenId, 1);
        assertEq(nft.ownerOf(tokenId), ownerA);
        assertEq(nft.accessEpoch(tokenId), 1);
        assertEq(nft.creatorOf(tokenId), creator);
        assertEq(nft.policyHash(tokenId), POLICY);
        assertEq(nft.manifestURI(tokenId), "ipfs://manifest");
        assertEq(nft.tokenURI(tokenId), "ipfs://manifest");
    }

    function test_MintRejectsCreatorSpoofing() public {
        // ownerA tries to mint a token attributed to `creator`
        vm.prank(ownerA);
        vm.expectRevert(IRightsNFT.NotCreator.selector);
        nft.mint(ownerA, creator, POLICY, ASSET_ID, CONTENT_HASH, "ipfs://m");
        // zero creator is never a valid msg.sender either
        vm.prank(ownerA);
        vm.expectRevert(IRightsNFT.NotCreator.selector);
        nft.mint(ownerA, address(0), POLICY, ASSET_ID, CONTENT_HASH, "ipfs://m");
    }

    function test_TransferBumpsEpochByOne() public {
        uint256 tokenId = _mint("ipfs://m");
        vm.prank(ownerA);
        nft.transferFrom(ownerA, ownerB, tokenId);
        assertEq(nft.ownerOf(tokenId), ownerB);
        assertEq(nft.accessEpoch(tokenId), 2);
        vm.prank(ownerB);
        nft.transferFrom(ownerB, ownerA, tokenId);
        assertEq(nft.accessEpoch(tokenId), 3);
    }

    function test_ApprovedOperatorTransferBumpsEpoch() public {
        uint256 tokenId = _mint("ipfs://m");
        vm.prank(ownerA);
        nft.setApprovalForAll(operator, true);
        vm.prank(operator);
        nft.safeTransferFrom(ownerA, ownerB, tokenId);
        assertEq(nft.ownerOf(tokenId), ownerB);
        assertEq(nft.accessEpoch(tokenId), 2);
    }

    function test_SafeTransferReceiverSeesNewEpochAndRejectionRollsBack() public {
        uint256 tokenId = _mint("ipfs://m");
        EpochObservingReceiver accepting = new EpochObservingReceiver(nft, false);
        vm.prank(ownerA);
        nft.safeTransferFrom(ownerA, address(accepting), tokenId);
        // the epoch is already advanced when the receiver callback runs (state before interaction)
        assertEq(accepting.observedEpoch(), 2);
        assertEq(nft.accessEpoch(tokenId), 2);

        EpochObservingReceiver rejecting = new EpochObservingReceiver(nft, true);
        vm.prank(address(accepting));
        vm.expectRevert();
        nft.safeTransferFrom(address(accepting), address(rejecting), tokenId);
        // whole tx reverted: owner and epoch unchanged
        assertEq(nft.ownerOf(tokenId), address(accepting));
        assertEq(nft.accessEpoch(tokenId), 2);
    }

    function testFuzz_EpochIsMonotonicAcrossTransfers(uint8 hops) public {
        uint256 tokenId = _mint("ipfs://m");
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
        uint256 tokenId = _mint("ipfs://m");
        vm.prank(ownerA);
        nft.transferFrom(ownerA, ownerA, tokenId);
        assertEq(nft.accessEpoch(tokenId), 2);
    }

    function test_SetPolicyOnlyCreatorAndDoesNotTouchEpoch() public {
        uint256 tokenId = _mint("ipfs://m");
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

    function test_NonOwnerCannotTransfer() public {
        uint256 tokenId = _mint("ipfs://m");
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
