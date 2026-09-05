# infra — Hedera サブグラフを EC2 にデプロイする CDK スタック

`HederaSubgraphStack` は EC2 を 1 台立て、userData で `deploy/docker-compose.prod.yaml`
を起動し、`MyToken`（ERC-721）サブグラフをビルド&デプロイする。

## 構成

- デフォルト VPC のパブリックサブネットに `t3.medium` / Ubuntu 24.04 LTS / gp3 30GB を 1 台
- Security Group inbound: `8000/tcp` のみ（`allowedSshCidr` context 指定時のみ `22/tcp` を追加）
- 管理ポート（8020 等）は compose 側で `127.0.0.1` バインド、多層防御
- IAM Role: `AmazonSSMManagedInstanceCore` のみ（SSH 鍵不要、SSM Session Manager で接続）
- Elastic IP を関連付け（`cdk destroy` で association ごと解放）
- userData は薄く保ち、実処理は `deploy/ec2-bootstrap.sh` に委譲

## 前提

- Node.js 20+ / pnpm / AWS CLI v2 / 認証済みの AWS プロファイル（または SSO）
- リポジトリの `main` が GitHub に push 済みであること（userData が clone する）

## セットアップ

```bash
cd hedera-subgraph-example/infra
pnpm install
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=ap-northeast-1
```

## パラメータ（context、すべて既定値あり）

| 名前 | 既定値 | 用途 |
|---|---|---|
| `repoUrl` | `https://github.com/mashharuki/hedra-sample.git` | userData の clone 元 |
| `repoBranch` | `main` | clone するブランチ |
| `instanceType` | `t3.medium` | EC2 サイズ |
| `allowedSshCidr` | なし | 指定時のみ `22/tcp` をこの CIDR に開放 |

例: `pnpm exec cdk deploy -c instanceType=t3.large -c allowedSshCidr=203.0.113.4/32`

## デプロイ

```bash
# 初回のみ（アカウント×リージョンごと）
pnpm exec cdk bootstrap

# デプロイ
pnpm exec cdk deploy

# 生成された cdk.context.json（VPC ルックアップ結果）をコミットしておく
git add cdk.context.json && git commit -m "Add CDK context (VPC lookup)"
```

出力される `GraphqlUrl` を控える。

## 確認

初回は Docker イメージ取得 + サブグラフのインデックス同期に **5〜15 分** かかる。

```bash
# 数分待ってから
curl -s <GraphqlUrl> \
  -H 'content-type: application/json' \
  -d '{"query":"{ _meta { block { number } } collection(id:\"0x94f5c9f6a59c257823fa5fecd8e7a15f8ed94029\"){ totalSupply } }"}'
```

`{"data":{...}}` が返れば成功。`no data found` 系は同期待ち。

## ログ / トラブルシュート

```bash
# SSM でインスタンスに入る（SSH 不要）
aws ssm start-session --target <InstanceId> --region ap-northeast-1

# 中で
sudo tail -n 200 -f /var/log/subgraph-userdata.log
sudo tail -n 200 -f /var/log/subgraph-bootstrap.log
cd /opt/app/hedera-subgraph-example
sudo docker compose -f deploy/docker-compose.prod.yaml logs -f graph-node
```

よくある問題:

| 症状 | 対処 |
|---|---|
| graph-node が `collation` エラーで起動しない | `deploy/docker-compose.prod.yaml` の `postgres` に `POSTGRES_INITDB_ARGS: '-E UTF8 --locale=C'` を足し、`sudo rm -rf data/postgres` して `docker compose ... up -d` で作り直す |
| 同期が異常に遅い / RPC エラー多発 | Hashio のレート制限。`config/testnet.json` の `startBlock` を最近のブロックに上げて `pnpm compile` → `pnpm exec graph deploy --version-label v0.0.2 MyToken`。または `/opt/app/hedera-subgraph-example/.env` に `GRAPH_ETHEREUM_RPC=<専用RPC>` を書いて `docker compose ... up -d` |
| userData が途中で失敗 | ログを確認し原因を潰したあと、`sudo bash /opt/app/hedera-subgraph-example/deploy/ec2-bootstrap.sh` を手動再実行（冪等） |

## 撤去

```bash
pnpm exec cdk destroy
```

Elastic IP も association ごと削除される（解放漏れ課金なし）。

## 開発

```bash
pnpm test       # vitest（スタックのアサーションテスト）
pnpm typecheck  # tsc --noEmit
pnpm synth      # cdk synth（AWS 認証情報が必要）
```
