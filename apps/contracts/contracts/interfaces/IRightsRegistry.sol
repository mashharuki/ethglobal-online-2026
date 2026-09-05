// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title IRightsRegistry - atomic x402 settlement, Rights Receipt lifecycle, revenue vault.
/// @notice Payment asset is native HBAR. Contract accounting is in tinybar (msg.value / 1e10).
///         Spec: specs/001-rights-runtime-mvp/contracts/solidity-interfaces.md
interface IRightsRegistry {
    /// @dev The 17 EIP-712 fields minus `chainId` / `verifyingContract` (supplied by the
    ///      contract), plus the settlement inputs `price` (tinybar) and the revenue split.
    struct ReceiptParams {
        address nftContract;
        uint256 tokenId;
        bytes32 resourceHash;
        bytes32 policyHash;
        uint256 licenseEpoch; // caller passes the current value; verified on-chain
        uint256 ownerEpochAtIssue; // = RightsNFT.accessEpoch(tokenId); verified on-chain
        address licensee;
        uint8 permittedAction;
        uint8 transferMode; // 0 SURVIVE_TRANSFER / 1 INVALIDATE_ON_TRANSFER
        uint32 maxUses;
        uint64 expiresAt; // duration = expiresAt - issuedAt (R-6a)
        bytes32 purchaseRequestHash;
        bytes32 paymentId;
        bytes32 nonce;
        uint64 issuedAt;
        uint256 price; // tinybar (10^8 = 1 HBAR)
        uint16 creatorBps; // + ownerBps == 10000
        uint16 ownerBps;
    }

    // ============ 1. atomic settlement (R-2 primary) ============

    /// @notice 1 tx: receive HBAR (msg.value) -> RevenueAllocation -> ReceiptIssued.
    function settleAndIssue(ReceiptParams calldata p) external payable returns (bytes32 receiptHash);

    // ============ 2. atomic consume (R-3 / R-3a, operator only) ============

    function consume(bytes32 receiptHash, uint32 useIndex) external;

    // ============ 3. KeyGate licensee-path authority views ============

    function hasValidConsumption(bytes32 receiptHash, uint32 useIndex) external view returns (bool);

    function receiptStatus(bytes32 receiptHash)
        external
        view
        returns (
            bool issued,
            uint256 tokenId,
            uint256 licenseEpochAtIssue,
            uint256 ownerEpochAtIssue,
            address licensee,
            uint8 transferMode,
            uint32 maxUses,
            uint32 usedCount,
            uint64 expiresAt
        );

    // ============ 4. License Epoch ============

    function licenseEpoch(uint256 tokenId) external view returns (uint256);

    /// @notice creator or admin only.
    function bumpLicenseEpoch(uint256 tokenId) external;

    // ============ 5. pull-based claim (FR-009 / FR-022) ============

    /// @return tinybar
    function claimable(address account) external view returns (uint256);

    function allocationOf(bytes32 paymentId)
        external
        view
        returns (address creator, uint256 creatorAmount, address owner, uint256 ownerAmount, uint256 blockNumber);

    /// @notice nonReentrant; pays out msg.sender's claimable (tinybar -> weibar) in native HBAR.
    function claim() external;

    // ============ 6. R-2 fallback only ============

    function payFor(bytes32 paymentId, bytes32 committedParamsHash) external payable;

    function finalize(bytes32 paymentId, ReceiptParams calldata p) external returns (bytes32 receiptHash);

    function refundUnfinalized(bytes32 paymentId) external;

    // ---- events (indexed by the subgraph) ----

    event ReceiptIssued(
        bytes32 indexed receiptHash,
        uint256 indexed tokenId,
        bytes32 policyHash,
        address indexed licensee,
        uint64 expiresAt,
        uint32 maxUses
    );
    event ReceiptConsumed(bytes32 indexed receiptHash, uint32 useIndex);
    event RevenueAllocated(
        uint256 indexed tokenId,
        bytes32 indexed paymentId,
        address creator,
        uint256 creatorAmount,
        address owner,
        uint256 ownerAmount,
        uint256 blockNumber
    );
    event LicenseEpochBumped(uint256 indexed tokenId, uint256 newEpoch);
    event Claimed(address indexed account, uint256 amount);
    event PaymentPending(
        bytes32 indexed paymentId, address indexed payer, uint256 amountTinybar, bytes32 committedParamsHash
    );
    event PaymentRefunded(bytes32 indexed paymentId, address indexed payer, uint256 amountTinybar);

    // ---- custom errors (identifiers match contracts/error-codes.md; `-> CODE` is parsed by tests) ----

    error UnderPayment(); // -> UNDERPAYMENT
    error ReceiptAlreadyIssued(); // -> PAYMENT_ID_PAYLOAD_CONFLICT
    error ReceiptAlreadyConsumed(); // -> RECEIPT_ALREADY_CONSUMED
    error ReceiptExpired(); // -> RECEIPT_EXPIRED
    error UseLimitExceeded(); // -> USE_LIMIT_EXCEEDED
    error LicenseEpochMismatch(); // -> LICENSE_EPOCH_MISMATCH
    error LicenseInvalidatedOnTransfer(); // -> LICENSE_INVALIDATED_ON_TRANSFER
    error ResourceHashMismatch(); // -> RESOURCE_HASH_MISMATCH
    error PolicyHashMismatch(); // -> POLICY_HASH_MISMATCH
    error PolicyContentMismatch(); // -> POLICY_CONTENT_MISMATCH
    error ExpiryMismatch(); // -> EXPIRY_MISMATCH
    error BpsInvalid();
    error ContractWalletUnsupported(); // -> CONTRACT_WALLET_UNSUPPORTED
    error NotIssued();
    error NotAuthorized(); // -> NOT_AUTHORIZED
    error CommittedParamsMismatch(); // -> COMMITTED_PARAMS_MISMATCH
    error OwnerEpochMismatch(); // -> OWNER_EPOCH_MISMATCH
    error PaymentNotPending();
    error RefundNotYetAllowed();
}
