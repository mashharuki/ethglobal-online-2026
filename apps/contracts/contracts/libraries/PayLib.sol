// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title PayLib - native HBAR payout from tinybar-denominated accounting (R-4).
/// @dev Hedera exposes native value to Solidity in tinybar (10^8 = 1 HBAR). JSON-RPC clients
///      use 18-decimal weibar, but the relay performs that conversion before EVM execution.
///      HTS / USDC / 0x167 / association are intentionally not used.
library PayLib {
    error NativeTransferFailed(address to, uint256 amountTinybar);

    /// @notice Sends a tinybar-denominated native value and reverts on failure.
    function sendValue(address payable to, uint256 amountTinybar) internal {
        (bool ok,) = to.call{value: amountTinybar}("");
        if (!ok) revert NativeTransferFailed(to, amountTinybar);
    }
}
