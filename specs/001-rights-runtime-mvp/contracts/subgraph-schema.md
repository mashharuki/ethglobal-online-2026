# Data supply 層の契約（Rights Graph / The Graph subgraph）

**用途は発見・監査のみ。認可判定に使わない（FR-020・憲章 II）。**

**構成**（`hedra-sample/hedera-subgraph-example` 準拠、R-5）: `specVersion 0.0.4` / `apiVersion 0.0.6` / `network: testnet` / `wasm/assemblyscript`。ソースは `apps/subgraph/`。

**ホスティング**: Hedera は Subgraph Studio / Hosted Service 非対応のため、`apps/cdk`（AWS CDK）でプロビジョニングした **AWS EC2 1 台 + docker-compose**（`graph-node` + PostgreSQL + IPFS、`ethereum` provider = Hedera JSON-RPC relay）で自前ホストする。**ハッカソン期間のみの一時インフラ、終了後 `cdk destroy`**。**The Graph の賞トラックには submit しない**（要件「local-only は不可」を満たせない、R-5）。

## `subgraph.yaml`（データソース）

```yaml
dataSources:
  - kind: ethereum/contract
    name: RightsNFT
    network: testnet
    source: { address: "0x…RightsNFT", abi: RightsNFT, startBlock: <deploy block> }
    mapping:
      entities: [RightsToken, TransferEvent, Owner]
      eventHandlers:
        - event: Transfer(indexed address,indexed address,indexed uint256)
          handler: handleTransfer
        - event: PolicyUpdated(indexed uint256,bytes32,bytes32)
          handler: handlePolicyUpdated
  - kind: ethereum/contract
    name: RightsRegistry
    network: testnet
    source: { address: "0x…RightsRegistry", abi: RightsRegistry, startBlock: <deploy block> }
    mapping:
      entities: [Receipt, Consumption, RevenueAllocation, LicenseEpochChange, Claim]
      eventHandlers:
        - event: ReceiptIssued(indexed bytes32,indexed uint256,bytes32,indexed address,uint64,uint32)
          handler: handleReceiptIssued
        - event: ReceiptConsumed(indexed bytes32,uint32)
          handler: handleReceiptConsumed
        - event: RevenueAllocated(indexed uint256,indexed bytes32,address,uint256,address,uint256,uint256)
          handler: handleRevenueAllocated
        - event: LicenseEpochBumped(indexed uint256,uint256)
          handler: handleLicenseEpochBumped
        - event: Claimed(indexed address,uint256)
          handler: handleClaimed
```

## `schema.graphql`

```graphql
type RightsToken @entity {
  id: ID!                      # tokenId
  owner: Owner!
  creator: Bytes!
  accessEpoch: BigInt!         # transfers 数から算出（mint = 1）
  policyHash: Bytes!
  manifestURI: String!
  licenseEpoch: BigInt!        # LicenseEpochChange の最新
  transfers: [TransferEvent!]! @derivedFrom(field: "token")
  receipts: [Receipt!]! @derivedFrom(field: "token")
  allocations: [RevenueAllocation!]! @derivedFrom(field: "token")
  totalRevenue: BigInt!        # allocations の合計（creator+owner）
}

type Owner @entity {
  id: ID!                      # address
  tokens: [RightsToken!]! @derivedFrom(field: "owner")
}

type TransferEvent @entity(immutable: true) {
  id: ID!                      # txHash-logIndex
  token: RightsToken!
  from: Bytes!
  to: Bytes!
  blockNumber: BigInt!
  timestamp: BigInt!
}

type Receipt @entity {
  id: ID!                      # receiptHash
  token: RightsToken!
  licensee: Bytes!
  policyHash: Bytes!
  transferMode: Int!           # 0 SURVIVE / 1 INVALIDATE
  maxUses: Int!
  expiresAt: BigInt!
  usedCount: Int!              # Consumption 数
  issuedAtBlock: BigInt!
  consumptions: [Consumption!]! @derivedFrom(field: "receipt")
}

type Consumption @entity(immutable: true) {
  id: ID!                      # receiptHash-useIndex
  receipt: Receipt!
  useIndex: Int!
  blockNumber: BigInt!
}

type RevenueAllocation @entity(immutable: true) {
  id: ID!                      # paymentId
  token: RightsToken!
  creator: Bytes!
  creatorAmount: BigInt!
  owner: Bytes!                # settlement 時点の owner（A-5）
  ownerAmount: BigInt!
  blockNumber: BigInt!
}

type LicenseEpochChange @entity(immutable: true) {
  id: ID!
  token: RightsToken!
  newEpoch: BigInt!
  blockNumber: BigInt!
}

type Claim @entity(immutable: true) {
  id: ID!
  account: Bytes!
  amount: BigInt!
  blockNumber: BigInt!
}
```

## デモ / 審査で使うクエリ

**Agent の発見**（`apps/gateway/src/mcp/tools/discoverAssets.ts` / CI harness の `apps/agent/src/`）
```graphql
{ rightsTokens {
    id manifestURI policyHash accessEpoch
    receipts { id maxUses usedCount expiresAt transferMode } } }
```
→ Agent は `manifestURI` を IPFS から取得して価格・条件を読み、購入判断（発見のみ、認可には使わない）。

**Dashboard の「移転で権利がどう変わったか」**（`apps/web/src/routes/Dashboard.tsx`）
```graphql
{ rightsToken(id: "1") {
    accessEpoch
    transfers(orderBy: blockNumber) { from to blockNumber }
    receipts { id licensee transferMode usedCount }
    allocations(orderBy: blockNumber) { owner ownerAmount creatorAmount blockNumber } } }
```
→ 「移転前後で `owner` 宛の allocation 受取先が変わっている」「`SURVIVE` の Receipt は `usedCount` が移転後も増えている」を可視化。

**監査：攻撃が拒否された記録**は subgraph には出ない（成功イベントのみ index）。拒否ログは Gateway の `GET /audit`（`gateway-api.md`）で見る。

## The Graph トラック要件（`docs/idea.md` §16.1）

- 「Graph 製品を 2 つ以上」：Subgraph（本体）＋ Substreams か Token API（余力があれば）。最低限「標準スキーマ上に構築」を満たすため `RightsToken` / `Owner` / `TransferEvent` は標準 ERC-721 subgraph の命名慣習を踏襲。
- 「AI Agent が実データを消費する本体インフラ」：Agent の `discover` が subgraph をクエリして自律的に購入資産を選ぶ = load-bearing。
