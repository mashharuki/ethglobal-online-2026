// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRightsNFT} from "./interfaces/IRightsNFT.sol";
import {IRightsRegistry} from "./interfaces/IRightsRegistry.sol";
import {PayLib} from "./libraries/PayLib.sol";
import {ReceiptLib} from "./libraries/ReceiptLib.sol";
import {RevenueLib} from "./libraries/RevenueLib.sol";

/// @title RightsRegistry - atomic x402 settlement, Rights Receipt lifecycle, revenue vault.
/// @notice Authorization authority for the licensee path (constitution II / V):
///         `settleAndIssue` (1 tx: HBAR in -> RevenueAllocation -> ReceiptIssued),
///         `consume` (operator only, exactly one success per (receiptHash, useIndex)),
///         `hasValidConsumption` / `receiptStatus` views, License Epoch, pull-based `claim`,
///         and the R-2a `payFor` / `finalize` / `refundUnfinalized` fallback rail.
///         All amounts are tinybar; weibar appears only at the EVM boundary (PayLib).
contract RightsRegistry is IRightsRegistry, ReentrancyGuard {
    // ------------------------------------------------------------------ config

    /// @notice Max age of a quote (`issuedAt`) accepted at settlement (R-6a step 2b).
    uint64 public constant ISSUANCE_WINDOW = 10 minutes;
    /// @notice After this delay an unfinalized `payFor` deposit can be reclaimed by the payer.
    uint64 public constant REFUND_TIMEOUT = 1 hours;

    uint8 internal constant TRANSFER_MODE_SURVIVE = 0;
    uint8 internal constant TRANSFER_MODE_INVALIDATE = 1;

    IRightsNFT public immutable rightsNFT;
    address public immutable admin;
    /// @notice The gateway operator key; the only account allowed to call `consume` (R-3a).
    address public operator;

    // ------------------------------------------------------------------- state

    struct ReceiptState {
        bool issued;
        uint8 transferMode;
        uint32 maxUses;
        uint32 usedCount;
        uint64 expiresAt;
        address licensee;
        uint256 tokenId;
        bytes32 policyHash;
        uint256 licenseEpochAtIssue;
        uint256 ownerEpochAtIssue;
    }

    struct Allocation {
        address creator;
        uint256 creatorAmount;
        address owner;
        uint256 ownerAmount;
        uint256 blockNumber;
    }

    struct Pending {
        address payer;
        uint64 depositedAt;
        uint256 amountTinybar;
        bytes32 committedParamsHash;
    }

    mapping(bytes32 receiptHash => ReceiptState) private _receipts;
    mapping(bytes32 receiptHash => mapping(uint32 useIndex => bool)) private _consumed;
    mapping(uint256 tokenId => uint256) private _licenseEpoch;
    mapping(address account => uint256 tinybar) private _claimable;
    mapping(bytes32 paymentId => Allocation) private _allocations;
    mapping(bytes32 paymentId => Pending) private _pending;

    error NothingToClaim();
    error OperatorZero();

    event OperatorChanged(address indexed previousOperator, address indexed newOperator);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotAuthorized();
        _;
    }

    constructor(IRightsNFT rightsNFT_, address admin_, address operator_) {
        if (operator_ == address(0)) revert OperatorZero();
        rightsNFT = rightsNFT_;
        admin = admin_;
        operator = operator_;
        emit OperatorChanged(address(0), operator_);
    }

    /// @notice Admin rotates the gateway operator key.
    function setOperator(address newOperator) external {
        if (msg.sender != admin) revert NotAuthorized();
        if (newOperator == address(0)) revert OperatorZero();
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    // ================================================== 1. atomic settlement

    /// @inheritdoc IRightsRegistry
    function settleAndIssue(ReceiptParams calldata p) external payable nonReentrant returns (bytes32 receiptHash) {
        // exact-amount rail: msg.value (weibar) must equal price (tinybar) * 1e10
        if (p.price == 0 || msg.value != PayLib.toWeibar(p.price)) revert UnderPayment();
        receiptHash = _settle(p);
    }

    /// @dev Steps 1-15 of solidity-interfaces.md "settleAndIssue の内部ロジック", shared by
    ///      the primary rail (`settleAndIssue`, value already checked) and `finalize` (deposit checked).
    function _settle(ReceiptParams calldata p) private returns (bytes32 receiptHash) {
        // 1. revenue split
        if (uint256(p.creatorBps) + uint256(p.ownerBps) != RevenueLib.BPS_DENOMINATOR) revert BpsInvalid();
        // 3. resource binding (nftContract + tokenId + assetId + contentHash recomputed by RightsNFT)
        if (p.nftContract != address(rightsNFT) || rightsNFT.resourceHash(p.tokenId) != p.resourceHash) {
            revert ResourceHashMismatch();
        }
        // 2. policy binding
        if (rightsNFT.policyHash(p.tokenId) != p.policyHash) revert PolicyHashMismatch();
        // 2b. issuedAt freshness / ordering (R-6a)
        if (p.expiresAt <= p.issuedAt) revert ExpiryMismatch();
        // never sell a receipt that is already unusable (short durations + late finalize)
        if (p.expiresAt <= block.timestamp) revert ExpiryMismatch();
        if (p.issuedAt > block.timestamp || block.timestamp - p.issuedAt > ISSUANCE_WINDOW) revert ExpiryMismatch();
        // 2a. policy content re-derivation (R-6a): the caller cannot reuse a genuine policyHash
        //     while changing price / maxUses / transferMode / duration / split.
        if (ReceiptLib.policyContentHash(p) != p.policyHash) revert PolicyContentMismatch();
        // 4. license epoch
        if (_licenseEpoch[p.tokenId] != p.licenseEpoch) revert LicenseEpochMismatch();
        // 5. owner epoch at issue must be the live value
        if (rightsNFT.accessEpoch(p.tokenId) != p.ownerEpochAtIssue) revert OwnerEpochMismatch();
        if (p.transferMode > TRANSFER_MODE_INVALIDATE) revert PolicyContentMismatch();
        // 6-7. receiptHash (EIP-712 hashStruct) is the authorization key; issue at most once
        receiptHash = ReceiptLib.hashStruct(p, block.chainid, address(this));
        if (_receipts[receiptHash].issued) revert ReceiptAlreadyIssued();
        // paymentId is single-use across all receipts (PAYMENT_ID_PAYLOAD_CONFLICT on-chain side)
        if (_allocations[p.paymentId].blockNumber != 0) revert ReceiptAlreadyIssued();
        // a paymentId with a live fallback deposit belongs to that depositor; the primary rail
        // must not be able to burn it (finalize deletes the pending entry before calling _settle)
        if (_pending[p.paymentId].payer != address(0)) revert ReceiptAlreadyIssued();
        // 8. EOA licensees only (FR-025)
        if (p.licensee == address(0) || p.licensee.code.length != 0) revert ContractWalletUnsupported();

        // 10-13. revenue to creator + owner at settlement time (A-5); allocation is immutable
        address owner = rightsNFT.ownerOf(p.tokenId);
        address creator = rightsNFT.creatorOf(p.tokenId);
        (uint256 creatorAmount, uint256 ownerAmount) = RevenueLib.split(p.price, p.creatorBps, p.ownerBps);
        _claimable[creator] += creatorAmount;
        _claimable[owner] += ownerAmount;
        _allocations[p.paymentId] = Allocation({
            creator: creator,
            creatorAmount: creatorAmount,
            owner: owner,
            ownerAmount: ownerAmount,
            blockNumber: block.number
        });

        // 14. receipt state
        _receipts[receiptHash] = ReceiptState({
            issued: true,
            transferMode: p.transferMode,
            maxUses: p.maxUses,
            usedCount: 0,
            expiresAt: p.expiresAt,
            licensee: p.licensee,
            tokenId: p.tokenId,
            policyHash: p.policyHash,
            licenseEpochAtIssue: p.licenseEpoch,
            ownerEpochAtIssue: p.ownerEpochAtIssue
        });

        // 15. events
        emit RevenueAllocated(p.tokenId, p.paymentId, creator, creatorAmount, owner, ownerAmount, block.number);
        emit ReceiptIssued(receiptHash, p.tokenId, p.policyHash, p.licensee, p.expiresAt, p.maxUses);
    }

    // ================================================== 2. consume

    /// @inheritdoc IRightsRegistry
    function consume(bytes32 receiptHash, uint32 useIndex) external onlyOperator {
        _revertIfInvalid(_validity(receiptHash, useIndex));
        _consumed[receiptHash][useIndex] = true;
        _receipts[receiptHash].usedCount += 1;
        emit ReceiptConsumed(receiptHash, useIndex);
    }

    // ================================================== 3. authority views

    /// @inheritdoc IRightsRegistry
    function hasValidConsumption(bytes32 receiptHash, uint32 useIndex) external view returns (bool) {
        // This is eligibility for an unused index, not proof of a past consumption.
        // Use isConsumed to distinguish a settled use from an index that can still be spent.
        return _validity(receiptHash, useIndex) == VALID;
    }

    /// @inheritdoc IRightsRegistry
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
        )
    {
        ReceiptState storage r = _receipts[receiptHash];
        return (
            r.issued,
            r.tokenId,
            r.licenseEpochAtIssue,
            r.ownerEpochAtIssue,
            r.licensee,
            r.transferMode,
            r.maxUses,
            r.usedCount,
            r.expiresAt
        );
    }

    function isConsumed(bytes32 receiptHash, uint32 useIndex) external view returns (bool) {
        return _consumed[receiptHash][useIndex];
    }

    // ================================================== 4. license epoch

    /// @inheritdoc IRightsRegistry
    function licenseEpoch(uint256 tokenId) external view returns (uint256) {
        return _licenseEpoch[tokenId];
    }

    /// @inheritdoc IRightsRegistry
    function bumpLicenseEpoch(uint256 tokenId) external {
        if (msg.sender != admin && msg.sender != rightsNFT.creatorOf(tokenId)) revert NotAuthorized();
        // Revoke a whole generation without iterating over receipts or changing owner privileges.
        uint256 next = _licenseEpoch[tokenId] + 1;
        _licenseEpoch[tokenId] = next;
        emit LicenseEpochBumped(tokenId, next);
    }

    // ================================================== 5. pull claim

    /// @inheritdoc IRightsRegistry
    function claimable(address account) external view returns (uint256) {
        return _claimable[account];
    }

    /// @inheritdoc IRightsRegistry
    function allocationOf(bytes32 paymentId)
        external
        view
        returns (address creator, uint256 creatorAmount, address owner, uint256 ownerAmount, uint256 blockNumber)
    {
        Allocation storage a = _allocations[paymentId];
        return (a.creator, a.creatorAmount, a.owner, a.ownerAmount, a.blockNumber);
    }

    /// @inheritdoc IRightsRegistry
    /// @dev CEI: balance is zeroed before the external call; nonReentrant as defense in depth.
    function claim() external nonReentrant {
        // Withdraw the allocation fixed at settlement; a later NFT transfer cannot redirect it.
        uint256 amount = _claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        _claimable[msg.sender] = 0;
        emit Claimed(msg.sender, amount);
        PayLib.sendValue(payable(msg.sender), amount);
    }

    // ================================================== 6. R-2a fallback rail

    /// @inheritdoc IRightsRegistry
    function payFor(bytes32 paymentId, bytes32 committedParamsHash) external payable {
        if (msg.value == 0 || msg.value % PayLib.WEIBAR_PER_TINYBAR != 0) revert UnderPayment();
        if (_pending[paymentId].payer != address(0) || _allocations[paymentId].blockNumber != 0) {
            revert ReceiptAlreadyIssued();
        }
        uint256 amountTinybar = msg.value / PayLib.WEIBAR_PER_TINYBAR;
        _pending[paymentId] = Pending({
            payer: msg.sender,
            depositedAt: uint64(block.timestamp),
            amountTinybar: amountTinybar,
            committedParamsHash: committedParamsHash
        });
        emit PaymentPending(paymentId, msg.sender, amountTinybar, committedParamsHash);
    }

    /// @inheritdoc IRightsRegistry
    /// @dev Permissionless, but only the exact ReceiptParams committed at `payFor` (licensee
    ///      included) can complete the deposit, so nobody can redirect someone else's payment.
    function finalize(bytes32 paymentId, ReceiptParams calldata p)
        external
        nonReentrant
        returns (bytes32 receiptHash)
    {
        Pending memory pending = _pending[paymentId];
        if (pending.payer == address(0)) revert PaymentNotPending();
        if (p.paymentId != paymentId || ReceiptLib.committedParamsHash(p) != pending.committedParamsHash) {
            revert CommittedParamsMismatch();
        }
        if (p.price == 0 || pending.amountTinybar != p.price) revert UnderPayment();
        // _settle rejects live deposits. Deleting first also prevents reuse; a revert restores
        // the deposit, so failed finalization does not erase the payer's refund entitlement.
        delete _pending[paymentId];
        receiptHash = _settle(p);
    }

    /// @inheritdoc IRightsRegistry
    function refundUnfinalized(bytes32 paymentId) external nonReentrant {
        Pending memory pending = _pending[paymentId];
        if (pending.payer == address(0)) revert PaymentNotPending();
        if (msg.sender != pending.payer) revert NotAuthorized();
        if (block.timestamp < uint256(pending.depositedAt) + REFUND_TIMEOUT) revert RefundNotYetAllowed();
        delete _pending[paymentId];
        emit PaymentRefunded(paymentId, pending.payer, pending.amountTinybar);
        PayLib.sendValue(payable(pending.payer), pending.amountTinybar);
    }

    function pendingOf(bytes32 paymentId)
        external
        view
        returns (address payer, uint64 depositedAt, uint256 amountTinybar, bytes32 committedParamsHash)
    {
        Pending storage pd = _pending[paymentId];
        return (pd.payer, pd.depositedAt, pd.amountTinybar, pd.committedParamsHash);
    }

    // ================================================== internal: validity predicate

    uint8 private constant VALID = 0;
    uint8 private constant INVALID_NOT_ISSUED = 1;
    uint8 private constant INVALID_EXPIRED = 2;
    uint8 private constant INVALID_LICENSE_EPOCH = 3;
    uint8 private constant INVALID_TRANSFER = 4;
    uint8 private constant INVALID_USE_LIMIT = 5;
    uint8 private constant INVALID_ALREADY_CONSUMED = 6;

    /// @dev data-model.md §1.2 predicate, evaluated in the documented order.
    function _validity(bytes32 receiptHash, uint32 useIndex) private view returns (uint8) {
        ReceiptState storage r = _receipts[receiptHash];
        if (!r.issued) return INVALID_NOT_ISSUED;
        if (block.timestamp >= r.expiresAt) return INVALID_EXPIRED;
        if (r.licenseEpochAtIssue != _licenseEpoch[r.tokenId]) return INVALID_LICENSE_EPOCH;
        // SURVIVE_TRANSFER deliberately ignores Owner Epoch: ownership and paid access age
        // independently. Only INVALIDATE_ON_TRANSFER receipts inherit transfer revocation.
        if (r.transferMode == TRANSFER_MODE_INVALIDATE && r.ownerEpochAtIssue != rightsNFT.accessEpoch(r.tokenId)) {
            return INVALID_TRANSFER;
        }
        // Bound each distinct index and reject its reuse. The gateway allocates indices;
        // this predicate does not require useIndex to equal usedCount.
        if (useIndex >= r.maxUses) return INVALID_USE_LIMIT;
        if (_consumed[receiptHash][useIndex]) return INVALID_ALREADY_CONSUMED;
        return VALID;
    }

    function _revertIfInvalid(uint8 code) private pure {
        if (code == VALID) return;
        if (code == INVALID_NOT_ISSUED) revert NotIssued();
        if (code == INVALID_EXPIRED) revert ReceiptExpired();
        if (code == INVALID_LICENSE_EPOCH) revert LicenseEpochMismatch();
        if (code == INVALID_TRANSFER) revert LicenseInvalidatedOnTransfer();
        if (code == INVALID_USE_LIMIT) revert UseLimitExceeded();
        revert ReceiptAlreadyConsumed();
    }
}
