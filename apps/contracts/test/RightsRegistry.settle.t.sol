// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IRightsRegistry} from "../contracts/interfaces/IRightsRegistry.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";

/// @dev A licensee with code (contract wallet) - must be rejected (FR-025).
contract ContractWallet {}

/// @title T031 - settleAndIssue: 1 tx = HBAR in + RevenueAllocation + ReceiptIssued, and every guard.
contract RightsRegistrySettleTest is RegistryTestBase {
    function test_SettleIssuesReceiptAllocatesRevenueAndEmits() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "s1");
        bytes32 expected = _expectedHash(p);

        vm.expectEmit(true, true, false, true);
        emit IRightsRegistry.RevenueAllocated(
            tokenId, p.paymentId, creator, 150_000_000, ownerA, 350_000_000, block.number
        );
        vm.expectEmit(true, true, true, true);
        emit IRightsRegistry.ReceiptIssued(expected, tokenId, p.policyHash, buyer, p.expiresAt, MAX_USES);

        bytes32 receiptHash = _settleAs(buyer, p);
        assertEq(receiptHash, expected);
        assertEq(address(reg).balance, PRICE_WEIBAR);
        assertEq(reg.claimable(creator), 150_000_000);
        assertEq(reg.claimable(ownerA), 350_000_000);

        (bool issued, uint256 tid,,, address licensee, uint8 mode, uint32 maxUses, uint32 used, uint64 exp) =
            reg.receiptStatus(receiptHash);
        assertTrue(issued);
        assertEq(tid, tokenId);
        assertEq(licensee, buyer);
        assertEq(mode, SURVIVE);
        assertEq(maxUses, MAX_USES);
        assertEq(used, 0);
        assertEq(exp, p.expiresAt);
        assertTrue(reg.hasValidConsumption(receiptHash, 0));
    }

    function test_RevertsUnderPaymentWhenValueDiffersFromPrice() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "u1");
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.UnderPayment.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR - 1e10}(p);
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.UnderPayment.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR + 1e10}(p);
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.UnderPayment.selector);
        reg.settleAndIssue{value: 0}(p);
        assertEq(address(reg).balance, 0);
    }

    function test_RevertsReceiptAlreadyIssuedOnReplayAndPaymentIdReuse() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "r1");
        _settleAs(buyer, p);
        // exact replay
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.ReceiptAlreadyIssued.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(p);
        // same paymentId, different nonce (different receiptHash) -> still rejected
        p.nonce = keccak256("other-nonce");
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.ReceiptAlreadyIssued.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(p);
    }

    function test_RevertsBpsInvalid() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "b1");
        p.creatorBps = 3000;
        p.ownerBps = 6999;
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.BpsInvalid.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(p);
    }

    function test_RevertsResourceHashMismatch() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "h1");
        p.resourceHash = keccak256("asset-b");
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.ResourceHashMismatch.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(p);

        IRightsRegistry.ReceiptParams memory q = _params(buyer, "h2");
        q.nftContract = address(0xdead);
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.ResourceHashMismatch.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(q);
    }

    function test_RevertsPolicyHashMismatch() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "p1");
        p.policyHash = keccak256("tampered");
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.PolicyHashMismatch.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(p);
    }

    function test_RevertsPolicyContentMismatchWhenContentChangedUnderGenuineHash() public {
        // genuine policyHash copied from chain, but price lowered (R-6a attack)
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "c1");
        p.price = 1;
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.PolicyContentMismatch.selector);
        reg.settleAndIssue{value: 1e10}(p);

        IRightsRegistry.ReceiptParams memory q = _params(buyer, "c2");
        q.maxUses = type(uint32).max;
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.PolicyContentMismatch.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(q);

        IRightsRegistry.ReceiptParams memory r = _params(buyer, "c3");
        r.expiresAt = r.issuedAt + DURATION * 10;
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.PolicyContentMismatch.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(r);
    }

    function test_RevertsExpiryMismatchForFutureStaleOrInvertedIssuedAt() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "e1");
        p.issuedAt = uint64(block.timestamp) + 1;
        p.expiresAt = p.issuedAt + DURATION;
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.ExpiryMismatch.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(p);

        IRightsRegistry.ReceiptParams memory q = _params(buyer, "e2");
        vm.warp(block.timestamp + reg.ISSUANCE_WINDOW() + 1);
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.ExpiryMismatch.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(q);

        IRightsRegistry.ReceiptParams memory r = _params(buyer, "e3");
        r.expiresAt = r.issuedAt;
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.ExpiryMismatch.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(r);
    }

    function test_RevertsLicenseEpochMismatchAfterBump() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "l1"); // licenseEpoch = 0
        vm.prank(creator);
        reg.bumpLicenseEpoch(tokenId);
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.LicenseEpochMismatch.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(p);
    }

    function test_RevertsOwnerEpochMismatchWhenQuoteIsStaleAcrossTransfer() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "o1"); // ownerEpochAtIssue = 1
        _transfer(ownerA, ownerB); // accessEpoch -> 2
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.OwnerEpochMismatch.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(p);
    }

    function test_RevertsContractWalletUnsupported() public {
        ContractWallet wallet = new ContractWallet();
        IRightsRegistry.ReceiptParams memory p = _params(address(wallet), "w1");
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.ContractWalletUnsupported.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(p);

        IRightsRegistry.ReceiptParams memory q = _params(address(0), "w2");
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.ContractWalletUnsupported.selector);
        reg.settleAndIssue{value: PRICE_WEIBAR}(q);
    }

    function test_PayerNeedNotBeLicensee() public {
        // a facilitator / feePayer may submit on the buyer's behalf; revenue and receipt are unaffected
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "f1");
        bytes32 h = _settleAs(buyer2, p);
        (,,,, address licensee,,,,) = reg.receiptStatus(h);
        assertEq(licensee, buyer);
    }
}
