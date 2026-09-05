// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title RevenueLib - two-party split in tinybar with zero dust (SC-006 / FR-022).
/// @dev creatorAmount + ownerAmount == price always holds: the mulDiv remainder is
///      assigned to the creator (no treasury, research.md R-4 / M-4).
library RevenueLib {
    uint16 internal constant BPS_DENOMINATOR = 10_000;

    function split(uint256 priceTinybar, uint16 creatorBps, uint16 ownerBps)
        internal
        pure
        returns (uint256 creatorAmount, uint256 ownerAmount)
    {
        creatorAmount = Math.mulDiv(priceTinybar, creatorBps, BPS_DENOMINATOR);
        ownerAmount = Math.mulDiv(priceTinybar, ownerBps, BPS_DENOMINATOR);
        uint256 dust = priceTinybar - creatorAmount - ownerAmount;
        creatorAmount += dust;
    }
}
