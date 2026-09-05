# 契約（Contracts）インデックス

レイヤー間の境界。ここが「合意」であり、各レイヤーはこれに沿って独立に実装・テストできる。

| ファイル | 境界 | 消費側 |
|---|---|---|
| [error-codes.md](./error-codes.md) | 全レイヤー共通のエラーコード（§10.1 の 14 種 + 補助） | contracts / gateway / web / agent / tests |
| [eip712-types.md](./eip712-types.md) | EIP-712 typed data（`RightsReceipt` / `KeyGateChallenge` / `OwnerAuthChallenge`） | contracts（`ReceiptLib`）/ gateway / web / agent |
| [rights-manifest.schema.json](./rights-manifest.schema.json) | Rights Manifest の JSON Schema | web（Creator）/ gateway（検証）/ agent（発見） |
| [solidity-interfaces.md](./solidity-interfaces.md) | `IRightsNFT` / `IRightsRegistry` の関数・イベント・カスタムエラー | contracts / gateway（`viem` ABI）/ subgraph |
| [gateway-api.md](./gateway-api.md) | Access Gateway HTTP API（人間向け解説。機械可読 SoT は `packages/openapi/openapi.yaml`、FR-029） | web / agent / gateway |
| `packages/openapi/openapi.yaml` | Access Gateway HTTP API の **OpenAPI 3.1 定義（単一の真実源）**。`openapi-typescript` で型生成 | apps/gateway / apps/web / apps/agent / apps/e2e（Newman） |
| [mcp-tools.md](./mcp-tools.md) | AI Agent 向け MCP Server のツール（`discover_assets` / `buy_access` / `decrypt_content`、v1.6） | apps/gateway（`src/mcp/`）/ Claude Code・Codex 等の外部AIクライアント / apps/agent（CI harness） |
| [subgraph-schema.md](./subgraph-schema.md) | Rights Graph の GraphQL スキーマとイベントマッピング | web（Dashboard）/ agent（発見） |

## レイヤー責務の一覧（`docs/idea.md` §9.2 準拠）

| レイヤー | 実行体 | 責務 | 権威か |
|---|---|---|---|
| Smart Contract | `apps/contracts/` on Hedera Testnet | 所有権・`accessEpoch`・`licenseEpoch`・Receipt 状態・`RevenueAllocation`・原子的 settlement・原子的 consume・Pull claim | **✅ 唯一の権威**（憲章 II） |
| Backend | `apps/gateway/` Hono + Cloudflare Workers（+ Durable Objects / Hyperdrive→Postgres / KV / Secrets Store） | オンチェーン直読み認可、x402 ゲート（`x402-hono`）、KeyGate `share_G` 放出判定、Receipt 消費の DO 直列化 + DB `UNIQUE`、EIP-712 Receipt 署名、監査ログ | ❌ 非権威（防御的多重化のみ） |
| Frontend | `apps/web/` Vite + React + Tailwind CSS + Privy | Creator Console、Marketplace/Viewer、KeyGate クライアント側復号、Rights Graph Dashboard（2 分割デモ画面）。Cloudflare Pages に静的デプロイ | ❌ |
| AI Agent | `apps/gateway/src/mcp/`（MCP Server、Cloudflare Workers に相乗り）。実行体は Claude Code / Codex 等の外部AIクライアント（v1.6） | `/mcp` 経由で discover_assets → buy_access → decrypt_content を公開。分析回答は接続元AIの推論（ツール化しない） | ❌ |
| Agent CI Harness | `apps/agent/` Node（v1.6よりCI専用。旧「AI Agent Node CLI」の役割はMCP Serverへ移設） | 自前 MCP クライアント + Claude tool-use で discover_assets → buy_access → decrypt_content → analyze を自動検証（SC-007/009、人手介入 0） | ❌ |
| Data supply | `apps/subgraph/` The Graph、`apps/cdk` の AWS EC2（docker-compose）で自前ホスト（ハッカソン期間のみ、R-5） | イベント index、Dashboard / Agent への供給 | ❌ 発見・監査のみ（FR-020） |

## デプロイ順（day1〜）

1. `apps/contracts` を Hedera Testnet にデプロイ → `packages/shared/src/addresses.ts` へ書き戻し（`RightsNFT`, `RightsRegistry`）。決済はネイティブ HBAR ＝ トークンアドレス不要
2. デモ用アカウントへ HBAR を配布（`seed.ts`）。token association は不要
3. `cdk deploy` で `GraphNodeStack`（AWS EC2 + docker-compose）を建て、`apps/subgraph` を deploy tx の `startBlock` で `graph deploy`
4. `apps/gateway` を起動（`addresses.ts` + KMS / Secrets Store 参照）
5. `apps/web` / `apps/agent`（CI harness） を `addresses.ts` + gateway URL + subgraph URL で設定。`apps/gateway` の `/mcp` を Claude Code / Codex から remote MCP server として追加すれば AI Agent デモの準備完了
6. `seed.ts` でデモ用 NFT 2 種を mint・Manifest 登録（`SURVIVE_TRANSFER` / `INVALIDATE_ON_TRANSFER` を各 1）
7. ハッカソン終了後：`cdk destroy` で Graph Node インフラを撤去
