# Rights Graph (apps/subgraph)

TrueCollective の **Rights Graph** = `RightsNFT` / `RightsRegistry`（Hedera Testnet）を index する
The Graph subgraph。**用途は発見（AI Agent の `discover_assets`）と監査（Dashboard）のみ**で、
認可判定には一切使わない（FR-020・憲章 II）。認可は Gateway が毎回オンチェーンを `eth_call` する。

Hedera は Subgraph Studio / Hosted Service 非対応のため、`apps/cdk` が建てる EC2 上の
self-hosted Graph Node（`graph-node` + PostgreSQL + IPFS、provider = Hedera JSON-RPC relay）へ
デプロイする（ハッカソン期間のみ。終了後 `cdk destroy`）。The Graph の賞トラックには submit しない。
仕様: `specs/001-rights-runtime-mvp/contracts/subgraph-schema.md`。

## 構成

| ファイル | 役割 |
| --- | --- |
| `subgraph.template.yaml` | マニフェスト（`{{network}}` / `{{RightsNFT}}` / `{{RightsRegistry}}` / `{{startBlock}}` を mustache で差し込み） |
| `config/testnet.json` | アドレスと startBlock。`apps/contracts` の `deploy:testnet` が書き戻す |
| `schema.graphql` | `RightsToken` / `Owner` / `TransferEvent` / `Receipt` / `Consumption` / `RevenueAllocation` / `LicenseEpochChange` / `Claim` |
| `src/mappings/rightsNft.ts` | `Transfer`（mint = accessEpoch 1、以後 +1）/ `PolicyUpdated` |
| `src/mappings/rightsRegistry.ts` | `ReceiptIssued` / `ReceiptConsumed` / `RevenueAllocated` / `LicenseEpochBumped` / `Claimed` |
| `abis/*.json` | `pnpm sync-abis` が `apps/contracts/artifacts` から抽出（コミット済み） |
| `tests/*.test.ts` | matchstick-as ユニットテスト（fixture イベント → エンティティ） |
| `graph-node/docker-compose.yaml` | ローカル graph-node（`pnpm graph-node`） |

## コマンド

```bash
pnpm --filter subgraph sync-abis   # contracts をビルドした後に ABI を取り込む
pnpm --filter subgraph build       # manifest 生成 → codegen → wasm build
pnpm --filter subgraph test        # graph test（matchstick）
pnpm --filter subgraph graph-node  # ローカル graph-node を docker compose で起動
pnpm --filter subgraph create      # graph create（GRAPH_NODE_ADMIN、既定 http://localhost:8020/）
pnpm --filter subgraph deploy      # graph deploy（GRAPH_NODE_ADMIN / GRAPH_NODE_IPFS / SUBGRAPH_VERSION）
```

デプロイ先 Graph Node の URL は `apps/cdk`（`GraphNodeStack`）の出力から取り、`GRAPH_NODE_ADMIN=http://<EIP>:8020/`
`GRAPH_NODE_IPFS=http://<EIP>:5001` を渡す。クエリ URL は `http://<EIP>:8000/subgraphs/name/truecollective/rights-graph`。

## 注意

- `subgraph.yaml` / `generated/` / `build/` / `tests/.bin` は生成物（gitignore）。
- 拒否（攻撃が弾かれた記録）は subgraph には出ない。成功イベントのみ index する。拒否ログは Gateway の `GET /audit`。
- `Receipt.transferMode` はイベントに含まれないため、`receiptStatus()` を eth_call して補完する。
