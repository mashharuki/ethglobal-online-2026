# apps/cdk — Rights Graph 用 self-hosted Graph Node（AWS CDK）

`GraphNodeStack` は EC2 を 1 台立て、user-data で `docker/docker-compose.graph-node.yml`
（`graph-node` + PostgreSQL + IPFS、`ethereum` provider = Hedera JSON-RPC relay）を起動する。
Hedera は Subgraph Studio / Hosted Service 非対応のため自前ホストする（research.md R-5）。

> **ハッカソン期間のみの一時インフラ。終了後は必ず `pnpm --filter cdk destroy` で撤去する**（憲章 VII / DoD #7）。
> `cdk deploy` は CI では回さない（手動）。The Graph の賞トラックには submit しない。

## 構成

- デフォルト VPC のパブリックサブネットに `t3.medium`（context で変更可）/ Ubuntu 24.04 / gp3 30GB（暗号化）
- Security Group inbound: `80/tcp` + `443/tcp`（Caddy 経由の GraphQL、公開）のみ既定。graph-node 自体の `8000` は公開しない。`allowedAdminCidr` 指定時のみ `8020`（graph deploy）/ `5001`（IPFS）/ `8030` をその CIDR に、`allowedSshCidr` 指定時のみ `22` をその CIDR に開放
- IAM Role: `AmazonSSMManagedInstanceCore` のみ（SSH 鍵不要・SSM Session Manager で接続）、IMDSv2 必須
- Elastic IP は EC2 インスタンス作成前に確保し、そのまま user-data（CDK トークン経由）へ埋め込んでから関連付ける（`cdk destroy` で解放）。Caddy が TLS 終端する `<EIP>.sslip.io` ホスト名は、この CloudFormation 参照で deploy 時に確定した値をそのまま焼き込む（インスタンス自身が起動時に IMDS で自己解決すると、EIP 関連付け完了前の一時的な public IP を掴む競合状態があり得るため採用しない・#45）
- user-data は compose ファイルを heredoc で埋め込み、`.env`（`HEDERA_RPC_URL` / `GRAPH_NODE_HOSTNAME`）を 0600 で書いて `docker compose up -d`。git clone はしない

## パラメータ（context、すべて既定値あり）

| 名前 | 既定値 | 用途 |
|---|---|---|
| `instanceType` | `t3.medium` | EC2 サイズ（day1 probe T021 の記録で決める） |
| `ebsGb` | `30` | ルート EBS |
| `hederaRpcUrl` | `https://testnet.hashio.io/api`（または `HEDERA_RPC_URL`） | graph-node の provider |
| `allowedAdminCidr` | なし | `8020` / `5001` / `8030` を開放する CIDR（`graph deploy` 実行元） |
| `allowedSshCidr` | なし | `22` を開放する CIDR |

## コマンド

```bash
pnpm --filter cdk test        # aws-cdk-lib/assertions（SG / EBS / EIP / user-data / スナップショット）
pnpm --filter cdk synth       # CloudFormation を合成（AWS 認証不要）
pnpm --filter cdk cdk bootstrap                      # 初回のみ（アカウント×リージョン）
pnpm --filter cdk run deploy -c allowedAdminCidr=203.0.113.4/32 # 手動デプロイ
pnpm --filter cdk run destroy # 撤去
```

デプロイ後の出力 `GraphNodeAdminUrl` / `IpfsUrl` を `apps/subgraph` の `GRAPH_NODE_ADMIN` / `GRAPH_NODE_IPFS`
に渡す。`create` は初回だけ必要で、その後に `deploy` を実行する。クエリ URL は `GraphqlUrl`。

```bash
export GRAPH_NODE_ADMIN=http://<EIP>:8020/
export GRAPH_NODE_IPFS=http://<EIP>:5001
pnpm --filter subgraph run create # 初回のみ
pnpm --filter subgraph run deploy
```

`allowedAdminCidr` を省略すると、Security Groupは8020 / 5001 / 8030を開放しない。
接続元IPが変わった場合も、現在のIPを指定してCDK deployを再実行すること。

## day1 probe（T021）

`PROBE_CONFIRM=yes ALLOWED_ADMIN_CIDR=<ip>/32 bash apps/cdk/scripts/probe-graph-node.sh`
— deploy → graph-node 到達待ち → subgraph deploy → `_meta.block.number` を 3 分観測 → `out/probe-graph-node.json`。
結果は research.md の「day1 probe 結果の記録欄」（R-5）へ手で転記する。**有料リソースなので `PROBE_CONFIRM=yes` が無ければ実行を拒否する。**

## 注意（運用上の罠）

- **user-data を変えると EC2 は置き換えられ、ルート EBS（Postgres / IPFS のデータ）も消える**（`userDataCausesReplacement`）。subgraph は再 deploy で再同期できるので許容しているが、長期運用ならデータ用 EBS を分離すること。
- `hederaRpcUrl` は CloudFormation テンプレートと `/opt/graph-node/.env` に平文で入る。**認証情報付き URL は使わない**（`validateRelayUrl` が userinfo 付き URL と shell に危険な文字を拒否する）。
- `allowedAdminCidr` / `allowedSshCidr` は `/16` より広い範囲（特に `0.0.0.0/0`）を拒否する。
- 旧テンプレートの `HederaSubgraphStack` をデプロイしたことがあるアカウントでは、本スタックとは別に残って課金される。`aws cloudformation delete-stack --stack-name HederaSubgraphStack --region <region>` で削除すること。

## ログ / トラブルシュート

```bash
aws ssm start-session --target <InstanceId> --region ap-northeast-1
sudo tail -n 200 -f /var/log/graph-node-userdata.log
cd /opt/graph-node && sudo docker compose logs -f graph-node
```
