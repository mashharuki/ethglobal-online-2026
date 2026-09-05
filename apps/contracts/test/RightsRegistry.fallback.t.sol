// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IRightsRegistry} from "../contracts/interfaces/IRightsRegistry.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";

/// @title T037 - R-2a fallback: payFor -> permissionless finalize bound to committed params; refund on timeout.
contract RightsRegistryFallbackTest is RegistryTestBase {
    /// @dev Pure local computation (no external call) so it never consumes a pending vm.prank.
    ///      abi.encode of a memory struct equals the calldata encoding used by ReceiptLib.
    function _commit(IRightsRegistry.ReceiptParams memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    function test_CommitHelperMatchesLibrary() public view {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "fb0");
        assertEq(_commit(p), this.committedHash(p));
    }

    function test_PayForRecordsPendingAndFinalizeIssues() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "fb1");
        bytes32 committed = _commit(p);
        vm.prank(buyer);
        vm.expectEmit(true, true, false, true);
        emit IRightsRegistry.PaymentPending(p.paymentId, buyer, PRICE, committed);
        reg.payFor{value: PRICE_WEIBAR}(p.paymentId, committed);
        (address payer,, uint256 amount, bytes32 stored) = reg.pendingOf(p.paymentId);
        assertEq(payer, buyer);
        assertEq(amount, PRICE);
        assertEq(stored, committed);

        // anyone may finalize with the committed params
        vm.prank(stranger);
        bytes32 h = reg.finalize(p.paymentId, p);
        assertEq(h, _expectedHash(p));
        assertTrue(reg.hasValidConsumption(h, 0));
        assertEq(reg.claimable(creator), 150_000_000);
        assertEq(reg.claimable(ownerA), 350_000_000);
        (address payerAfter,,,) = reg.pendingOf(p.paymentId);
        assertEq(payerAfter, address(0));
    }

    function test_FinalizeRejectsParamsThatDifferFromCommitment() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "fb2");
        vm.prank(buyer);
        reg.payFor{value: PRICE_WEIBAR}(p.paymentId, _commit(p));

        // attacker tries to redirect the deposit to themselves as licensee
        // (fresh copies: memory struct assignment would alias `p`)
        IRightsRegistry.ReceiptParams memory hijacked = _params(buyer, "fb2");
        hijacked.licensee = stranger;
        vm.prank(stranger);
        vm.expectRevert(IRightsRegistry.CommittedParamsMismatch.selector);
        reg.finalize(p.paymentId, hijacked);

        // paymentId in params must match the deposit key
        IRightsRegistry.ReceiptParams memory other = _params(buyer, "fb2");
        other.paymentId = keccak256("other");
        vm.prank(stranger);
        vm.expectRevert(IRightsRegistry.CommittedParamsMismatch.selector);
        reg.finalize(p.paymentId, other);
    }

    function test_FinalizeRejectsWhenDepositDoesNotMatchPrice() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "fb3");
        vm.prank(buyer);
        reg.payFor{value: PRICE_WEIBAR - 1e10}(p.paymentId, _commit(p));
        vm.prank(stranger);
        vm.expectRevert(IRightsRegistry.UnderPayment.selector);
        reg.finalize(p.paymentId, p);
    }

    function test_PayForRejectsZeroDuplicateAndSubTinybarValues() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "fb4");
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.UnderPayment.selector);
        reg.payFor{value: 0}(p.paymentId, _commit(p));
        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.UnderPayment.selector);
        reg.payFor{value: PRICE_WEIBAR + 1}(p.paymentId, _commit(p));
        vm.prank(buyer);
        reg.payFor{value: PRICE_WEIBAR}(p.paymentId, _commit(p));
        vm.prank(buyer2);
        vm.expectRevert(IRightsRegistry.ReceiptAlreadyIssued.selector);
        reg.payFor{value: PRICE_WEIBAR}(p.paymentId, _commit(p));
    }

    function test_FinalizeRequiresPendingAndCannotDoubleFinalize() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "fb5");
        vm.prank(stranger);
        vm.expectRevert(IRightsRegistry.PaymentNotPending.selector);
        reg.finalize(p.paymentId, p);
        vm.prank(buyer);
        reg.payFor{value: PRICE_WEIBAR}(p.paymentId, _commit(p));
        reg.finalize(p.paymentId, p);
        vm.expectRevert(IRightsRegistry.PaymentNotPending.selector);
        reg.finalize(p.paymentId, p);
    }

    function test_RefundOnlyPayerAfterTimeout() public {
        IRightsRegistry.ReceiptParams memory p = _params(buyer, "fb6");
        vm.prank(buyer);
        reg.payFor{value: PRICE_WEIBAR}(p.paymentId, _commit(p));

        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.RefundNotYetAllowed.selector);
        reg.refundUnfinalized(p.paymentId);

        vm.warp(block.timestamp + reg.REFUND_TIMEOUT());
        vm.prank(stranger);
        vm.expectRevert(IRightsRegistry.NotAuthorized.selector);
        reg.refundUnfinalized(p.paymentId);

        uint256 before = buyer.balance;
        vm.prank(buyer);
        vm.expectEmit(true, true, false, true);
        emit IRightsRegistry.PaymentRefunded(p.paymentId, buyer, PRICE);
        reg.refundUnfinalized(p.paymentId);
        assertEq(buyer.balance - before, PRICE_WEIBAR);
        assertEq(address(reg).balance, 0);

        vm.prank(buyer);
        vm.expectRevert(IRightsRegistry.PaymentNotPending.selector);
        reg.refundUnfinalized(p.paymentId);
    }
}
