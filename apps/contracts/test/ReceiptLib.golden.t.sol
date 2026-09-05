// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {IRightsRegistry} from "../contracts/interfaces/IRightsRegistry.sol";
import {ReceiptLib} from "../contracts/libraries/ReceiptLib.sol";

/// @dev Harness so the library's calldata functions can be exercised.
contract ReceiptLibHarness {
    function hashStruct(IRightsRegistry.ReceiptParams calldata p, uint256 chainId, address verifyingContract)
        external
        pure
        returns (bytes32)
    {
        return ReceiptLib.hashStruct(p, chainId, verifyingContract);
    }

    function policyContentHash(IRightsRegistry.ReceiptParams calldata p) external pure returns (bytes32) {
        return ReceiptLib.policyContentHash(p);
    }

    function digest(bytes32 structHash, uint256 chainId, address verifyingContract) external pure returns (bytes32) {
        return ReceiptLib.digest(structHash, chainId, verifyingContract);
    }
}

/// @title Golden test: Solidity hashStruct == packages/shared/test/eip712.golden.test.ts
/// @notice Fixture values mirror packages/shared/test/fixtures.ts GOLDEN_RECEIPT. Change both together.
contract ReceiptLibGoldenTest is Test {
    // ---- pinned by the TypeScript side (PR "feat(shared)") ----
    bytes32 internal constant GOLDEN_TYPEHASH = 0xd4aaed81b9c5f7040cca0726ae0a2c44640db626d394ef0d61351e1a90ee8ac4;
    bytes32 internal constant GOLDEN_RECEIPT_HASH = 0xc7f47a15158690ea6f43dd75a98b825cb606352a1d6e137f3641ff4556681a52;
    // computePolicyHash({priceTinybar: 500_000_000, durationSec: 300, maxUses: 5, permittedAction: 6,
    //   transferMode: 0, creatorBps: 3000, ownerBps: 7000}) - pinned in test/ReceiptLib.policy.golden.spec.ts
    bytes32 internal constant GOLDEN_POLICY_HASH = 0xeba5698d0b8fcd7d42d32191278887beb0997bef075812d00d9f9a10b4b4e29c;

    address internal constant REGISTRY = 0x1111111111111111111111111111111111111111;
    address internal constant NFT = 0x2222222222222222222222222222222222222222;
    address internal constant LICENSEE = 0x3333333333333333333333333333333333333333;

    ReceiptLibHarness internal harness;

    function setUp() public {
        harness = new ReceiptLibHarness();
    }

    function _golden() internal pure returns (IRightsRegistry.ReceiptParams memory p) {
        p.nftContract = NFT;
        p.tokenId = 1;
        p.resourceHash = bytes32(uint256(0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc));
        p.policyHash = bytes32(uint256(0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd));
        p.licenseEpoch = 1;
        p.ownerEpochAtIssue = 1;
        p.licensee = LICENSEE;
        p.permittedAction = 6;
        p.transferMode = 0;
        p.maxUses = 5;
        p.expiresAt = 1_800_000_300;
        p.purchaseRequestHash = bytes32(uint256(0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee));
        p.paymentId = bytes32(uint256(0x0101010101010101010101010101010101010101010101010101010101010101));
        p.nonce = bytes32(uint256(0x0202020202020202020202020202020202020202020202020202020202020202));
        p.issuedAt = 1_800_000_000;
        // settlement-only fields (not part of the 17-field EIP-712 struct)
        p.price = 500_000_000;
        p.creatorBps = 3000;
        p.ownerBps = 7000;
    }

    function test_TypehashMatchesTypeScript() public pure {
        assertEq(ReceiptLib.RIGHTS_RECEIPT_TYPEHASH, GOLDEN_TYPEHASH);
    }

    function test_HashStructMatchesTypeScriptGolden() public view {
        assertEq(harness.hashStruct(_golden(), 296, REGISTRY), GOLDEN_RECEIPT_HASH);
    }

    function test_HashStructIgnoresSettlementOnlyFields() public view {
        IRightsRegistry.ReceiptParams memory p = _golden();
        p.price = 1;
        p.creatorBps = 1;
        p.ownerBps = 9999;
        assertEq(harness.hashStruct(p, 296, REGISTRY), GOLDEN_RECEIPT_HASH);
    }

    function test_HashStructChangesWithChainIdAndContract() public view {
        assertNotEq(harness.hashStruct(_golden(), 295, REGISTRY), GOLDEN_RECEIPT_HASH);
        assertNotEq(harness.hashStruct(_golden(), 296, NFT), GOLDEN_RECEIPT_HASH);
    }

    function test_PolicyContentHashMatchesTypeScriptGolden() public view {
        assertEq(harness.policyContentHash(_golden()), GOLDEN_POLICY_HASH);
    }

    function test_PolicyContentHashRevertsWhenExpiresBeforeIssued() public {
        IRightsRegistry.ReceiptParams memory p = _golden();
        p.expiresAt = p.issuedAt - 1;
        vm.expectRevert();
        harness.policyContentHash(p);
    }

    function test_DigestUsesEip712Prefix() public view {
        bytes32 structHash = harness.hashStruct(_golden(), 296, REGISTRY);
        bytes32 expected = keccak256(abi.encodePacked(hex"1901", ReceiptLib.domainSeparator(296, REGISTRY), structHash));
        assertEq(harness.digest(structHash, 296, REGISTRY), expected);
    }
}
