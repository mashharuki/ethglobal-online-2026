// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IRightsRegistry} from "../contracts/interfaces/IRightsRegistry.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";

/// @title T038 - contracts/error-codes.md §10.1 matrix, contract-layer cut (constitution IV).
/// @dev Rows #2 (20 parallel) is covered by test/RightsRegistry.concurrent.spec.ts (real parallel tx);
///      rows #5 (chain id) and #6 (licensee signature) are gateway-layer EIP-712 checks - #5 is
///      covered here by showing a receipt hashed for another chainId is simply not issued.
contract AdversarialMatrixTest is RegistryTestBase {
    bytes32 internal h;

    function setUp() public override {
        super.setUp();
        h = _settleAs(buyer, _params(buyer, "matrix"));
    }

    /// #1 RECEIPT_ALREADY_CONSUMED - same (receiptHash, useIndex) twice
    function test_Row01_ReceiptAlreadyConsumed() public {
        _consume(h, 0);
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.ReceiptAlreadyConsumed.selector);
        reg.consume(h, 0);
    }

    /// #3 RESOURCE_HASH_MISMATCH - receipt for asset A presented for asset B (settle side)
    function test_Row03_ResourceHashMismatch() public {
        uint256 assetB = _mintAsset(SURVIVE);
        IRightsRegistry.ReceiptParams memory p = _params(assetB, buyer, SURVIVE, keccak256("r3p"), keccak256("r3n"));
        p.resourceHash = nft.resourceHash(tokenId); // asset A's resource on asset B's receipt
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.ResourceHashMismatch.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(p);
    }

    /// #4 POLICY_HASH_MISMATCH - tampered policy
    function test_Row04_PolicyHashMismatch() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "r4");
        p.policyHash = keccak256("tampered");
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.PolicyHashMismatch.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(p);
    }

    /// #5 CHAIN_ID_MISMATCH - contract-side evidence only: the receipt hash is domain-bound, so a
    ///    receipt hashed under another chainId (or contract) is simply not issued here. The EIP-712
    ///    signature check that returns CHAIN_ID_MISMATCH lives in the gateway (Phase 7).
    function test_Row05_ChainIdSpoofedReceiptIsNotIssued() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "matrix");
        // control: the correct-domain hash IS the issued receipt
        assertEq(this.hashParams(p, block.chainid, address(reg)), h);
        assertTrue(reg.hasValidConsumption(h, 0));
        bytes32 spoofed = this.hashParams(p, block.chainid == 295 ? 296 : 295, address(reg));
        assertNotEq(spoofed, h);
        bytes32 otherContract = this.hashParams(p, block.chainid, address(nft));
        assertNotEq(otherContract, h);
        assertFalse(reg.hasValidConsumption(otherContract, 0));
        assertFalse(reg.hasValidConsumption(spoofed, 0));
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.NotIssued.selector);
        reg.consume(spoofed, 0);
    }

    /// #7 RECEIPT_EXPIRED
    function test_Row07_ReceiptExpired() public {
        vm.warp(T0 + DURATION + 1);
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.ReceiptExpired.selector);
        reg.consume(h, 0);
    }

    /// #8 USE_LIMIT_EXCEEDED
    function test_Row08_UseLimitExceeded() public {
        for (uint32 i = 0; i < MAX_USES; i++) {
            _consume(h, i);
        }
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.UseLimitExceeded.selector);
        reg.consume(h, MAX_USES);
    }

    /// #9 UNDERPAYMENT
    function test_Row09_Underpayment() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "r9");
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.UnderPayment.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR / 2}(p);
    }

    /// #10 PAYMENT_ID_PAYLOAD_CONFLICT - same paymentId, different body
    function test_Row10_PaymentIdPayloadConflict() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "matrix");
        p.nonce = keccak256("different-body");
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.ReceiptAlreadyIssued.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(p);
    }

    /// #11 OWNER_EPOCH_MISMATCH - quote taken before a transfer
    function test_Row11_OwnerEpochMismatch() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "r11");
        _transfer(ownerA, ownerB);
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.OwnerEpochMismatch.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(p);
    }

    /// #12 PAID_LICENSE_TRANSFER_OK - SURVIVE receipt keeps working after transfer (negative test)
    function test_Row12_PaidLicenseTransferOk() public {
        _transfer(ownerA, ownerB);
        assertTrue(reg.hasValidConsumption(h, 0));
        _consume(h, 0);
    }

    /// #13 LICENSE_INVALIDATED_ON_TRANSFER
    function test_Row13_LicenseInvalidatedOnTransfer() public {
        uint256 id = _mintAsset(INVALIDATE);
        bytes32 hi = _settleAs(buyer, _params(id, buyer, INVALIDATE, keccak256("r13p"), keccak256("r13n")));
        vm.prank(ownerA);
        nft.transferFrom(ownerA, ownerB, id);
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.LicenseInvalidatedOnTransfer.selector);
        reg.consume(hi, 0);
    }

    /// #14 LICENSE_EPOCH_MISMATCH
    function test_Row14_LicenseEpochMismatch() public {
        vm.prank(creator);
        reg.bumpLicenseEpoch(tokenId);
        vm.prank(operator);
        vm.expectRevert(IRightsRegistry.LicenseEpochMismatch.selector);
        reg.consume(h, 0);
    }
}
