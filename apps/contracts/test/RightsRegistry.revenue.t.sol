// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IRightsRegistry} from "../contracts/interfaces/IRightsRegistry.sol";
import {ReceiptLib} from "../contracts/libraries/ReceiptLib.sol";
import {RevenueLib} from "../contracts/libraries/RevenueLib.sol";
import {RightsRegistry} from "../contracts/RightsRegistry.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RegistryTestBase} from "./RegistryTestBase.sol";

/// @dev Re-enters claim() from the payout callback; the second claim must fail.
contract ReentrantClaimer {
    RightsRegistry internal immutable reg;
    uint256 public reentered;
    bytes4 public innerSelector;

    constructor(RightsRegistry reg_) {
        reg = reg_;
    }

    function attack() external {
        reg.claim();
    }

    receive() external payable {
        reentered += 1;
        if (reentered == 1) {
            try reg.claim() {
                innerSelector = bytes4(0);
            } catch (bytes memory reason) {
                innerSelector = bytes4(reason);
            }
        }
    }
}

/// @title T032 - revenue split with zero dust, pull claim, immutable allocation.
contract RightsRegistryRevenueTest is RegistryTestBase {
    /// @dev 33.33333333 HBAR-ish price that does not divide evenly by the split.
    uint256 internal constant ODD_PRICE = 333_333_333;

    function _mintOddAsset() internal returns (uint256 id) {
        bytes32 ph = ReceiptLib.policyHashOf(ODD_PRICE, DURATION, MAX_USES, PERMS, SURVIVE, CREATOR_BPS, OWNER_BPS);
        vm.prank(creator);
        id = nft.mint(ownerA, creator, ph, ASSET_ID, CONTENT_HASH, "ipfs://odd");
    }

    function test_SplitSumsExactlyToPriceWithDustToCreator() public pure {
        (uint256 c, uint256 o) = RevenueLib.split(ODD_PRICE, CREATOR_BPS, OWNER_BPS);
        assertEq(c + o, ODD_PRICE);
        assertEq(o, 233_333_333); // floor(333333333 * 0.7)
        assertEq(c, 100_000_000); // floor(333333333 * 0.3) = 99999999 + dust 1
    }

    function testFuzz_SplitNeverLosesOrCreatesValue(uint96 price, uint16 creatorBps) public pure {
        vm.assume(creatorBps <= 10_000);
        uint16 ownerBps = 10_000 - creatorBps;
        (uint256 c, uint256 o) = RevenueLib.split(price, creatorBps, ownerBps);
        assertEq(c + o, uint256(price));
    }

    function test_SettleWithOddPriceAllocatesWithZeroDust() public {
        uint256 id = _mintOddAsset();
        IRightsRegistry.ReceiptParams memory p =
            _params(id, buyer, SURVIVE, keccak256("odd-pay"), keccak256("odd-nonce"));
        p.price = ODD_PRICE;
        vm.prank(buyer);
        reg.settleAndIssue{value: ODD_PRICE * 1e10}(p);
        (, uint256 cAmt,, uint256 oAmt,) = reg.allocationOf(p.paymentId);
        assertEq(cAmt + oAmt, ODD_PRICE);
        assertEq(reg.claimable(creator) + reg.claimable(ownerA), ODD_PRICE);
    }

    function test_ClaimPaysOutInWeibarAndZeroesBalanceOnce() public {
        _settleAs(buyer, _params(buyer, "claim1"));
        uint256 before = ownerA.balance;
        vm.prank(ownerA);
        vm.expectEmit(true, false, false, true);
        emit IRightsRegistry.Claimed(ownerA, 350_000_000);
        reg.claim();
        assertEq(ownerA.balance - before, 350_000_000 * 1e10);
        assertEq(reg.claimable(ownerA), 0);
        vm.prank(ownerA);
        vm.expectRevert(RightsRegistry.NothingToClaim.selector);
        reg.claim();
    }

    function test_AllocationIsImmutableAfterTransferAndFutureRevenueFollowsNewOwner() public {
        IRightsRegistry.ReceiptParams memory p1 = _params(buyer, "a1");
        _settleAs(buyer, p1);
        _transfer(ownerA, ownerB);
        (, uint256 c1, address o1, uint256 oa1,) = reg.allocationOf(p1.paymentId);
        assertEq(o1, ownerA); // settled allocation does not follow the transfer (FR-010)
        assertEq(c1, 150_000_000);
        assertEq(oa1, 350_000_000);

        IRightsRegistry.ReceiptParams memory p2 = _params(buyer2, "a2"); // fresh quote at epoch 2
        _settleAs(buyer2, p2);
        (,, address o2, uint256 oa2,) = reg.allocationOf(p2.paymentId);
        assertEq(o2, ownerB); // future revenue goes to the owner at settlement time (A-5)
        assertEq(oa2, 350_000_000);
        assertEq(reg.claimable(ownerA), 350_000_000);
        assertEq(reg.claimable(ownerB), 350_000_000);
        assertEq(reg.claimable(creator), 300_000_000);
    }

    function test_ClaimIsNonReentrant() public {
        ReentrantClaimer attacker = new ReentrantClaimer(reg);
        // make the attacker the creator so it accrues claimable revenue
        vm.prank(address(attacker));
        uint256 id = nft.mint(ownerA, address(attacker), _policyHash(SURVIVE), ASSET_ID, CONTENT_HASH, "ipfs://x");
        IRightsRegistry.ReceiptParams memory p = _params(id, buyer, SURVIVE, keccak256("re-pay"), keccak256("re-nonce"));
        _settleAs(buyer, p);
        uint256 owed = reg.claimable(address(attacker));
        assertEq(owed, 150_000_000);

        attacker.attack();
        assertEq(attacker.reentered(), 1);
        // the nested claim must be stopped by the reentrancy guard itself (not merely by
        // the zeroed balance, which would surface as NothingToClaim)
        assertEq(attacker.innerSelector(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(address(attacker).balance, owed * 1e10); // paid exactly once
        assertEq(reg.claimable(address(attacker)), 0);
    }
}
