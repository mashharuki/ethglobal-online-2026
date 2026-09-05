// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IRightsRegistry} from "../contracts/interfaces/IRightsRegistry.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";

/// @title T033 / T035 / T036 - consume, transfer modes, license epoch.
contract RightsRegistryConsumeTest is RegistryTestBase {
    bytes32 internal receiptHash;

    function setUp() public override {
        super.setUp();
        receiptHash = _settleAs(buyer, _params(buyer, "consume"));
    }

    function test_ConsumeIncrementsUsedCountAndEmits() public {
        vm.prank(operator);
        vm.expectEmit(true, false, false, true);
        emit IRightsRegistry.ReceiptConsumed(receiptHash, 0);
        reg.consume(receiptHash, 0);
        (,,,,,,, uint32 used,) = reg.receiptStatus(receiptHash);
        assertEq(used, 1);
        assertTrue(reg.isConsumed(receiptHash, 0));
        assertFalse(reg.hasValidConsumption(receiptHash, 0));
        assertTrue(reg.hasValidConsumption(receiptHash, 1));
    }

    function test_ConsumeIsOperatorOnly() public {
        vm.prank(stranger);
        vm.expectRevert(IRightsRegistry.NotAuthorized.selector);
        reg.consume(receiptHash, 0);
        vm.prank(buyer); // even the licensee cannot consume directly
        vm.expectRevert(IRightsRegistry.NotAuthorized.selector);
        reg.consume(receiptHash, 0);
        assertTrue(reg.hasValidConsumption(receiptHash, 0));
    }

    function test_AdminCanRotateOperator() public {
        vm.prank(stranger);
        vm.expectRevert(IRightsRegistry.NotAuthorized.selector);
        reg.setOperator(stranger);
        vm.prank(admin);
        reg.setOperator(stranger);
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.NotAuthorized.selector);
        reg.consume(receiptHash, 0);
        vm.prank(stranger);
        reg.consume(receiptHash, 0);
    }

    function test_SameUseIndexTwiceIsReceiptAlreadyConsumed() public {
        _consume(receiptHash, 0);
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.ReceiptAlreadyConsumed.selector);
        reg.consume(receiptHash, 0);
    }

    function test_UseLimitExceededAtMaxUses() public {
        for (uint32 i = 0; i < MAX_USES; i++) {
            _consume(receiptHash, i);
        }
        assertFalse(reg.hasValidConsumption(receiptHash, MAX_USES));
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.UseLimitExceeded.selector);
        reg.consume(receiptHash, MAX_USES);
    }

    function test_UnknownReceiptIsNotIssued() public {
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.NotIssued.selector);
        reg.consume(keccak256("nope"), 0);
        assertFalse(reg.hasValidConsumption(keccak256("nope"), 0));
    }

    function test_ExpiredReceiptIsRejected() public {
        vm.warp(T0 + DURATION);
        assertFalse(reg.hasValidConsumption(receiptHash, 0));
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.ReceiptExpired.selector);
        reg.consume(receiptHash, 0);
    }

    function test_SurviveTransferReceiptStillValidAfterTransfer() public {
        _consume(receiptHash, 0);
        _transfer(ownerA, ownerB);
        assertTrue(reg.hasValidConsumption(receiptHash, 1)); // PAID_LICENSE_TRANSFER_OK
        _consume(receiptHash, 1);
    }

    function test_InvalidateOnTransferReceiptRejectedAfterTransfer() public {
        uint256 id = _mintAsset(INVALIDATE);
        IRightsRegistry.ReceiptParams memory p =
            _params(id, buyer, INVALIDATE, keccak256("inv-pay"), keccak256("inv-nonce"));
        bytes32 h = _settleAs(buyer, p);
        _consume(h, 0);
        vm.prank(ownerA);
        nft.transferFrom(ownerA, ownerB, id);
        assertFalse(reg.hasValidConsumption(h, 1));
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.LicenseInvalidatedOnTransfer.selector);
        reg.consume(h, 1);
    }

    function test_MixedReceiptsOnOneAssetAcrossOneTransfer() public {
        // asset with INVALIDATE policy: 2 INVALIDATE receipts; base asset (SURVIVE): 2 SURVIVE receipts
        uint256 invId = _mintAsset(INVALIDATE);
        bytes32 s1 = receiptHash;
        bytes32 s2 = _settleAs(buyer2, _params(tokenId, buyer2, SURVIVE, keccak256("s2p"), keccak256("s2n")));
        bytes32 i1 = _settleAs(buyer, _params(invId, buyer, INVALIDATE, keccak256("i1p"), keccak256("i1n")));
        bytes32 i2 = _settleAs(buyer2, _params(invId, buyer2, INVALIDATE, keccak256("i2p"), keccak256("i2n")));

        _transfer(ownerA, ownerB);
        vm.prank(ownerA);
        nft.transferFrom(ownerA, ownerB, invId);

        assertTrue(reg.hasValidConsumption(s1, 0));
        assertTrue(reg.hasValidConsumption(s2, 0));
        assertFalse(reg.hasValidConsumption(i1, 0));
        assertFalse(reg.hasValidConsumption(i2, 0));
        _consume(s1, 0);
        _consume(s2, 0);
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.LicenseInvalidatedOnTransfer.selector);
        reg.consume(i1, 0);
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.LicenseInvalidatedOnTransfer.selector);
        reg.consume(i2, 0);
    }

    function test_BumpLicenseEpochInvalidatesOldReceipts() public {
        vm.prank(stranger);
        vm.expectRevert(IRightsRegistry.NotAuthorized.selector);
        reg.bumpLicenseEpoch(tokenId);

        vm.prank(creator);
        vm.expectEmit(true, false, false, true);
        emit IRightsRegistry.LicenseEpochBumped(tokenId, 1);
        reg.bumpLicenseEpoch(tokenId);
        assertEq(reg.licenseEpoch(tokenId), 1);
        assertFalse(reg.hasValidConsumption(receiptHash, 0));
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.LicenseEpochMismatch.selector);
        reg.consume(receiptHash, 0);

        // admin can also bump; a fresh receipt at the new epoch works
        vm.prank(admin);
        reg.bumpLicenseEpoch(tokenId);
        bytes32 fresh = _settleAs(buyer, _params(buyer, "fresh"));
        assertTrue(reg.hasValidConsumption(fresh, 0));
    }
}
