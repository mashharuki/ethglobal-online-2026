// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ProbeSettle - disposable day1 stand-in (tasks.md T018 / T020, research.md R-4 / R-2a).
/// @notice Records how native HBAR value behaves on Hedera EVM: msg.value unit (weibar), the
///         tinybar conversion, mulDiv dust in tinybar accounting, and `.call{value:}` payouts.
///         Exposes both `settleAndIssue`-shaped and `payFor`-shaped payable entry points so one
///         facilitator probe can test primary and fallback ContractCall payloads. Not part of the
///         product deployment (deploy.ts never touches it).
contract ProbeSettle {
    event Received(address indexed from, uint256 msgValueWeibar, uint256 priceTinybar, uint256 remainderWeibar);
    event Split(uint256 priceTinybar, uint256 creatorTinybar, uint256 ownerTinybar, uint256 dustTinybar);
    event PaidFor(bytes32 indexed paymentId, address indexed payer, uint256 msgValueWeibar);
    event PaidOut(address indexed to, uint256 amountWeibar, bool ok);

    uint256 public lastMsgValue;
    mapping(address => uint256) public balanceTinybar;

    error PriceMismatch(uint256 expectedTinybar, uint256 gotTinybar);

    /// @dev primary-shaped: exact price, value attached to a contract call.
    function settleAndIssue(bytes calldata, /* receiptParams (opaque for the probe) */ uint256 priceTinybar)
        external
        payable
    {
        lastMsgValue = msg.value;
        uint256 got = msg.value / 1e10;
        emit Received(msg.sender, msg.value, got, msg.value % 1e10);
        if (got != priceTinybar) revert PriceMismatch(priceTinybar, got);
        (uint256 c, uint256 o) = _split(priceTinybar, 3000, 7000);
        balanceTinybar[msg.sender] += c + o; // probe: everything back to the caller
    }

    /// @dev fallback-shaped: any value, keyed by paymentId.
    function payFor(bytes32 paymentId) external payable {
        lastMsgValue = msg.value;
        emit PaidFor(paymentId, msg.sender, msg.value);
        balanceTinybar[msg.sender] += msg.value / 1e10;
    }

    /// @dev Records the split of an arbitrary tinybar amount (R-4: dust is always 0 in tinybar).
    function splitProbe(uint256 priceTinybar, uint16 creatorBps, uint16 ownerBps) external returns (uint256, uint256) {
        return _split(priceTinybar, creatorBps, ownerBps);
    }

    /// @dev `.call{value:}` payout of the caller's tinybar balance; reports success without reverting.
    function withdraw() external returns (bool ok) {
        uint256 amount = balanceTinybar[msg.sender];
        balanceTinybar[msg.sender] = 0;
        (ok,) = msg.sender.call{value: amount * 1e10}("");
        emit PaidOut(msg.sender, amount * 1e10, ok);
        if (!ok) balanceTinybar[msg.sender] = amount;
    }

    function _split(uint256 priceTinybar, uint16 creatorBps, uint16 ownerBps)
        internal
        returns (uint256 creatorTinybar, uint256 ownerTinybar)
    {
        creatorTinybar = Math.mulDiv(priceTinybar, creatorBps, 10_000);
        ownerTinybar = Math.mulDiv(priceTinybar, ownerBps, 10_000);
        uint256 dust = priceTinybar - creatorTinybar - ownerTinybar;
        emit Split(priceTinybar, creatorTinybar, ownerTinybar, dust);
        creatorTinybar += dust;
    }
}
