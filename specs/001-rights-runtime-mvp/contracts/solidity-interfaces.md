# Smart Contract 層の契約（Solidity インターフェース）

**Chain**: Hedera Testnet（chainId `296`） / **Solidity** `0.8.34` / **evmVersion** `cancun` / **OpenZeppelin** `5.x`

コントラクトは 2 つ。`RightsNFT`（所有権と Owner Epoch）と `RightsRegistry`（決済・Receipt・収益）。

---

## `IRightsNFT`（ERC-721 拡張）

```solidity
interface IRightsNFT is IERC721 {
    // ---- views（Gateway / KeyGate / Lit 相当の条件評価がこれを eth_call）----
    function accessEpoch(uint256 tokenId) external view returns (uint256); // Owner Epoch（FR-001）
    function creatorOf(uint256 tokenId) external view returns (address);
    function policyHash(uint256 tokenId) external view returns (bytes32);
    function manifestURI(uint256 tokenId) external view returns (string memory);

    // ---- writes ----
    function mint(
        address to,
        address creator,
        bytes32 policyHash_,
        string calldata manifestURI_
    ) external returns (uint256 tokenId);

    function setPolicy(uint256 tokenId, bytes32 newPolicyHash, string calldata newManifestURI) external; // creator のみ

    // ---- events ----
    event PolicyUpdated(uint256 indexed tokenId, bytes32 oldPolicyHash, bytes32 newPolicyHash);
    // Transfer は ERC-721 標準

    // ---- errors ----
    error NotCreator();
    error NonexistentToken();
}
```

### 実装の要点

- `_update(address to, uint256 tokenId, address auth)` を override：
  ```solidity
  function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
      from = super._update(to, tokenId, auth);
      if (from != address(0) && to != address(0)) {
          _accessEpoch[tokenId] += 1;          // 唯一の更新主体（FR-001）
      }
  }
  ```
- `mint` 時 `_accessEpoch[tokenId] = 1`。
- `setPolicy` は `bumpLicenseEpoch` を **呼ばない**（License Epoch の更新は `RightsRegistry` 側、緊急失効時のみ）。ポリシー変更で既発行 Receipt の `policyHash` が古くなると、KeyGate の `resourceHash`/`policyHash` 照合で `POLICY_HASH_MISMATCH` になる（意図的）。
- `accessEpoch` に外部 setter を **一切設けない**（憲章 I / FR-001）。

---

## `IRightsRegistry`

```solidity
interface IRightsRegistry {

    // ============ 1. 原子的 settlement（R-2 primary）============
    /// x402「exact」ペイロードがこの関数への value 付き ContractCall。Blocky402 facilitator が
    /// gas を肩代わり（feePayer 0.0.7162784）して submit。決済資産は **ネイティブ HBAR**。
    /// 1 tx で：HBAR 受領（msg.value）→ RevenueAllocation 記録 → ReceiptIssued emit。
    struct ReceiptParams {
        address nftContract;
        uint256 tokenId;
        bytes32 resourceHash;
        bytes32 policyHash;
        uint256 licenseEpoch;        // 呼び出し側が現在値を渡す。contract 内で licenseEpoch[tokenId] と一致検証
        uint256 ownerEpochAtIssue;   // = RightsNFT.accessEpoch(tokenId) を呼び出し側が渡す。contract が検証
        address licensee;
        uint8   permittedAction;
        uint8   transferMode;        // 0 SURVIVE / 1 INVALIDATE
        uint32  maxUses;
        uint64  expiresAt;
        bytes32 purchaseRequestHash;
        bytes32 paymentId;
        bytes32 nonce;
        uint64  issuedAt;
        uint256 price;               // weibar（ネイティブ HBAR、10^18 = 1 HBAR。tinybar 精度のため 10^10 の倍数）。msg.value >= price を要求
        uint16  creatorBps;          // + ownerBps == 10000
        uint16  ownerBps;
    }

    function settleAndIssue(ReceiptParams calldata p)
        external
        payable
        returns (bytes32 receiptHash);
    // require(msg.value >= p.price) → UnderPayment
    // revert：UnderPayment / ReceiptAlreadyIssued / LicenseEpochMismatch /
    //         ResourceHashMismatch / PolicyHashMismatch / BpsInvalid / ContractWalletUnsupported

    // ============ 2. 原子的 consume（R-3、FR-007 / FR-018）============
    function consume(bytes32 receiptHash, uint32 useIndex) external;
    // Gateway のオペレータ鍵が呼ぶ。20 並列で 1 tx のみ成功。
    // revert：ReceiptExpired / LicenseEpochMismatch / LicenseInvalidatedOnTransfer /
    //         UseLimitExceeded / ReceiptAlreadyConsumed / NotIssued

    // ============ 3. KeyGate 購入者パスの権威 view ============
    function hasValidConsumption(bytes32 receiptHash, uint32 useIndex) external view returns (bool);
    function receiptStatus(bytes32 receiptHash) external view returns (
        bool issued, uint256 tokenId, uint256 licenseEpochAtIssue, uint256 ownerEpochAtIssue,
        address licensee, uint8 transferMode, uint32 maxUses, uint32 usedCount, uint64 expiresAt
    );

    // ============ 4. License Epoch（緊急失効・ポリシー更新）============
    function licenseEpoch(uint256 tokenId) external view returns (uint256);
    function bumpLicenseEpoch(uint256 tokenId) external; // creator or admin のみ（FR-013 系の LICENSE_EPOCH_MISMATCH）

    // ============ 5. Pull 型 claim（FR-009 / FR-022）============
    function claimable(address account) external view returns (uint256); // weibar
    function allocationOf(bytes32 paymentId) external view returns (
        address creator, uint256 creatorAmount, address owner, uint256 ownerAmount, uint256 blockNumber
    );
    function claim() external; // nonReentrant。msg.sender の claimable を **ネイティブ HBAR** で払い出し（CEI 順）

    // ============ 6. R-2 フォールバックのみ（primary が成立すれば未使用）============
    function payFor(bytes32 paymentId) external payable;            // fallback：buyer が HBAR を預ける（pending[paymentId] 記録）
    function finalize(bytes32 paymentId, ReceiptParams calldata p) external returns (bytes32 receiptHash); // 誰でも可。pending 額を検証
    function refundUnfinalized(bytes32 paymentId) external;        // timeout 後に buyer が HBAR を回収

    // ---- events（subgraph が index）----
    event ReceiptIssued(
        bytes32 indexed receiptHash, uint256 indexed tokenId, bytes32 policyHash,
        address indexed licensee, uint64 expiresAt, uint32 maxUses
    );
    event ReceiptConsumed(bytes32 indexed receiptHash, uint32 useIndex);
    event RevenueAllocated(
        uint256 indexed tokenId, bytes32 indexed paymentId,
        address creator, uint256 creatorAmount, address owner, uint256 ownerAmount, uint256 blockNumber
    );
    event LicenseEpochBumped(uint256 indexed tokenId, uint256 newEpoch);
    event Claimed(address indexed account, uint256 amount);

    // ---- custom errors（error-codes.md の識別子と一致させる）----
    error UnderPayment();                    // → UNDERPAYMENT
    error ReceiptAlreadyIssued();            // → PAYMENT_ID_PAYLOAD_CONFLICT（nonce/!issued）
    error ReceiptAlreadyConsumed();          // → RECEIPT_ALREADY_CONSUMED
    error ReceiptExpired();                  // → RECEIPT_EXPIRED
    error UseLimitExceeded();                // → USE_LIMIT_EXCEEDED
    error LicenseEpochMismatch();            // → LICENSE_EPOCH_MISMATCH
    error LicenseInvalidatedOnTransfer();    // → LICENSE_INVALIDATED_ON_TRANSFER
    error ResourceHashMismatch();            // → RESOURCE_HASH_MISMATCH
    error PolicyHashMismatch();              // → POLICY_HASH_MISMATCH
    error BpsInvalid();
    error ContractWalletUnsupported();       // → CONTRACT_WALLET_UNSUPPORTED（FR-025）
    error NotIssued();
    error NotAuthorized();
}
```

### `settleAndIssue` の内部ロジック（原子性の中心）

```
1. require(p.creatorBps + p.ownerBps == 10000)                      // BpsInvalid
2. require(RightsNFT.policyHash(p.tokenId) == p.policyHash)          // PolicyHashMismatch
3. require(_resourceHash(p.nftContract, p.tokenId, ...) == p.resourceHash)  // ResourceHashMismatch
4. require(licenseEpoch[p.tokenId] == p.licenseEpoch)               // LicenseEpochMismatch
5. require(RightsNFT.accessEpoch(p.tokenId) == p.ownerEpochAtIssue) // 発行時 Owner Epoch の真正性
6. receiptHash = ReceiptLib.hashStruct(p)                          // EIP-712（R-6）
7. require(!issued[receiptHash])                                    // ReceiptAlreadyIssued（nonce/二重発行）
8. require(p.licensee.code.length == 0)                             // ContractWalletUnsupported（FR-025）
9. require(msg.value == p.price)                                    // UnderPayment（x402「exact」＝ facilitator が正確な額を保証。HBAR は msg.value で受領済み。以降の分配は p.price を使う）
10. owner = RightsNFT.ownerOf(p.tokenId)                            // settlement 時点（A-5）
11. creatorAmount = p.price * p.creatorBps / 10000
    ownerAmount   = p.price - creatorAmount                         // 端数は owner ではなく…（下記）
    // 端数規則（R-4）：切り捨て余りを protocol treasury（未設定なら creator）へ
    //   creatorAmount = mulDiv(price, creatorBps, 10000)
    //   ownerAmount   = mulDiv(price, ownerBps, 10000)
    //   dust = price - creatorAmount - ownerAmount
    //   (treasury != 0) ? claimable[treasury] += dust : creatorAmount += dust
12. claimable[creator] += creatorAmount; claimable[owner] += ownerAmount
13. allocationOf[p.paymentId] = {creator, creatorAmount, owner, ownerAmount, block.number}  // 不可逆（FR-010）
14. issued[receiptHash] = true; 各 receipt フィールドを保存
15. emit RevenueAllocated(...); emit ReceiptIssued(...)
```

### `consume` の内部ロジック

```
1. require(hasValidConsumption(receiptHash, useIndex))  // 内訳は data-model.md の判定式（→ 対応する custom error）
2. consumed[receiptHash][useIndex] = true
3. usedCount[receiptHash] += 1
4. emit ReceiptConsumed(receiptHash, useIndex)
```

Hedera の合意順序により、同一 `(receiptHash, useIndex)` の 20 並列 tx のうち 1 つだけが step 2 を通過し、他は step 1 の `¬consumed` で `ReceiptAlreadyConsumed` revert（SC-005）。

---

## `ReceiptLib`（library）

- `hashStruct(ReceiptParams)` → `bytes32`：EIP-712 `keccak256(abi.encode(RIGHTS_RECEIPT_TYPEHASH, field1, ..., field17))`。**TypeScript 版（`packages/shared/eip712.ts`）と golden test で完全一致を検証**（憲章 IV、R-6）。
- `RIGHTS_RECEIPT_TYPEHASH` と `DOMAIN_SEPARATOR`（`name="TrueCollective", version="1", chainId=296, verifyingContract=RightsRegistry`）。

## `PayLib`（library）

- `sendValue(address payable to, uint256 amount)`：`to.call{value: amount}("")` を実行し、失敗時は revert（OZ `Address.sendValue` 相当）。`claim` / `refundUnfinalized` が使用。
- `RightsRegistry` は OZ `ReentrancyGuard` を継承し、払い出しは CEI 順（`claimable` をゼロ化してから `sendValue`）。
- **HTS / USDC / `0x167` / token association は不使用**。決済資産はネイティブ HBAR（`/supported` により Blocky402 は `hedera:testnet` で HTS トークンを扱わない、R-4 改訂）。

## デプロイ設定（`hardhat.config.ts`）

```ts
solidity: { version: "0.8.34", settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 } } }
networks: { testnet: { type: "http", url: configVariable("HEDERA_RPC_URL"), accounts: [configVariable("HEDERA_OPERATOR_KEY")] } }
```
