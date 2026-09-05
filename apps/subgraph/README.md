# Hedera Subgraph Example — MyToken (ERC-721)

`hardhat-erc-721-mint/contracts/MyToken.sol`（OpenZeppelin v5 の `ERC721 + Ownable`）を
Hedera Testnet 上でインデックスするサブグラフです。The Graph Protocol を使い、ローカルの
graph-node にデプロイして GraphQL で NFT の保有状況・移転履歴を照会できます。

サブグラフの詳細は [The Graph のドキュメント](https://thegraph.com/docs)、Hedera での
手順は [公式チュートリアル](https://docs.hedera.com/hedera/tutorials/smart-contracts/deploy-a-subgraph-using-the-graph) を参照してください。

## 対象コントラクト

| 項目 | 値 |
| --- | --- |
| コントラクト | `MyToken` (`MTK`) — ERC-721 |
| ネットワーク | Hedera Testnet (`testnet`) |
| アドレス | `0x94f5c9f6a59c257823fa5fecd8e7a15f8ed94029` |
| startBlock | `39895777` |
| ABI | `abis/MyToken.json`（`hardhat-erc-721-mint` の Hardhat artifact から抽出） |

アドレスと startBlock は `config/testnet.json` で管理し、`pnpm compile` 時に
`subgraph.template.yaml` へ mustache で差し込まれて `subgraph.yaml` が生成されます。

## インデックスするイベントとエンティティ

| イベント | ハンドラ | 主な更新対象 |
| --- | --- | --- |
| `Transfer(address,address,uint256)` | `handleTransfer` | `Token` / `Owner.balance` / `Collection` の集計（mint = `from` が 0x0、burn = `to` が 0x0）、`Transfer` 履歴 |
| `Approval(address,address,uint256)` | `handleApproval` | `Token.approved`、`Approval` 履歴 |
| `ApprovalForAll(address,address,bool)` | `handleApprovalForAll` | `ApprovalForAll` 履歴 |
| `OwnershipTransferred(address,address)` | `handleOwnershipTransferred` | `Collection.owner`、`OwnershipTransferred` 履歴 |

エンティティ:

- `Collection` — シングルトン。`owner` / `totalSupply` / `totalMinted` / `totalBurned`
- `Token` — NFT 1 枚ごとの現在状態（`owner` / `tokenURI` / `approved` / `burned` / mint 情報）
- `Owner` — アドレスごとの `balance` と保有トークン一覧（`tokens`）
- `Transfer` / `Approval` / `ApprovalForAll` / `OwnershipTransferred` — イミュータブルな履歴

## プロジェクト構成

- `subgraph.template.yaml` — マニフェストのテンプレート（`{{MyToken}}` / `{{startBlock}}`）
- `subgraph.yaml` — `pnpm compile` が生成する実際のマニフェスト（gitignore 対象）
- `schema.graphql` — GraphQL スキーマ（エンティティ定義）
- `src/mappings.ts` — イベントをエンティティへ変換する AssemblyScript マッピング
- `abis/MyToken.json` — MyToken の ABI
- `config/testnet.json` — アドレスと startBlock
- `graph-node/docker-compose.yaml` — ローカル graph-node / IPFS / Postgres
- `generated/` — `graph codegen` が生成する型（gitignore 対象）

## AWS へのデプロイ

ローカルではなく AWS 上（EC2 単一ホスト）で常時稼働させる場合は
[`infra/README.md`](infra/README.md) を参照。CDK (TypeScript) で
`cdk deploy` 一発で graph-node ごと立ち上がり、
`http://<Elastic IP>:8000/subgraphs/name/MyToken` で公開される。

## セットアップ

1. 依存関係をインストール:

```shell
pnpm install
```

2. `graph-node/docker-compose.yaml` の `ethereum` に Hashio Testnet の
   エンドポイント（`testnet:https://testnet.hashio.io/api`）が設定されていることを確認します。

3. ローカル graph-node を起動:

```shell
pnpm graph-node
```

4. マニフェスト生成 + 型生成 + ビルド:

```shell
pnpm compile
```

5. サブグラフを作成:

```shell
pnpm create-local
```

6. サブグラフをデプロイ:

```shell
pnpm deploy-local
```

インデックスが完了すると GraphQL API が
`http://localhost:8000/subgraphs/name/MyToken` で利用できます。

### クエリ例

```graphql
{
  collection(id: "0x94f5c9f6a59c257823fa5fecd8e7a15f8ed94029") {
    owner
    totalSupply
    totalMinted
  }
  tokens(first: 5, orderBy: tokenId) {
    tokenId
    owner { id }
    burned
    mintedTxHash
  }
  transfers(first: 5, orderBy: blockNumber, orderDirection: desc) {
    token { tokenId }
    from
    to
  }
}
```

# Contributing
Contributions are welcome. Please see the
[contributing guide](https://github.com/hashgraph/.github/blob/main/CONTRIBUTING.md)
to see how you can get involved.

# Code of Conduct
This project is governed by the
[Contributor Covenant Code of Conduct](https://github.com/hashgraph/.github/blob/main/CODE_OF_CONDUCT.md). By
participating, you are expected to uphold this code of conduct. Please report unacceptable behavior
to [oss@hedera.com](mailto:oss@hedera.com).

# License
[Apache License 2.0](LICENSE)
