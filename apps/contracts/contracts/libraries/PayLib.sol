// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title PayLib - native HBAR payout from tinybar-denominated accounting (R-4).
/// @dev Contract accounting is in tinybar (10^8 = 1 HBAR); the EVM boundary uses weibar
///      (10^18 = 1 HBAR), so amounts are scaled by 1e10 exactly once, here.
///      HTS / USDC / 0x167 / association are intentionally not used.
library PayLib {
    uint256 internal constant WEIBAR_PER_TINYBAR = 1e10;

    error NativeTransferFailed(address to, uint256 amountWeibar);

    function toWeibar(uint256 amountTinybar) internal pure returns (uint256) {
        return amountTinybar * WEIBAR_PER_TINYBAR;
    }

    /// @notice Sends `amountTinybar` (converted to weibar) with `.call{value:}` and reverts on failure.
    function sendValue(address payable to, uint256 amountTinybar) internal {
        uint256 amountWeibar = toWeibar(amountTinybar);
        (bool ok,) = to.call{value: amountWeibar}("");
        if (!ok) revert NativeTransferFailed(to, amountWeibar);
    }
}
