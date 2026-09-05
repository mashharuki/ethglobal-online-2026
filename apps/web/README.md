# frontend — x402 × Privy (Hedera testnet)

Privy 内蔵ウォレットで x402 の支払い署名データを生成し、`apps/server` の
`/premium`（x402 保護リソース）をブラウザから取得するサンプル。

> 以下のパスとコマンドはすべてリポジトリ内の `x402-sample/` ディレクトリを基準にする。

## セットアップ

```sh
cp apps/frontend/.env.example apps/frontend/.env
```

`apps/frontend/.env` を設定:

- `VITE_PRIVY_APP_ID` — Privy Dashboard の App ID
- `VITE_RESOURCE_SERVER_URL` — 値は `.env.example`
  （`http://localhost:4021`）から取る。コード側に既定値はなく、未設定なら
  `loadConfig` が例外を投げる

Privy Dashboard 側:

- Login methods に Email など任意の 1 つを有効化
- Embedded wallets を有効化（EVM）
- 開発を滑らかにするなら署名確認 UI を抑制（任意）

サーバー側 `apps/server/.env` に `ALLOWED_ORIGINS=http://localhost:5173` を設定
（Vite の既定ポート）。あわせて `PAY_TO_ACCOUNT_ID`（受取用 testnet 口座）を設定する。

資金投入スクリプトは `apps/client/.env` の `PAYER_ACCOUNT_ID` /
`PAYER_PRIVATE_KEY`（資金済み testnet 口座）を再利用する。未設定なら
`cp apps/client/.env.example apps/client/.env` して埋める。

## 実行

```sh
# 端末 1
pnpm dev:server

# 端末 2
pnpm --filter frontend dev
```

## 手動 E2E 手順書

1. `pnpm install`（初回のみ）。3 つの `.env`（`apps/server/.env` の
   `PAY_TO_ACCOUNT_ID` / `ALLOWED_ORIGINS`、`apps/client/.env` の `PAYER_*`、
   `apps/frontend/.env` の `VITE_*`）が揃っていることを確認する。
2. 端末 1 で `pnpm dev:server`。別端末で
   `curl http://localhost:4021/health` が `{"status":"ok"}` を返すことを確認。
3. 端末 2 で `pnpm --filter frontend dev`。ブラウザで Vite の URL
   （既定 `http://localhost:5173`）を開き、Privy でログインする。
4. 表示された Wallet（EVM アドレス）に資金を投入:
   ```sh
   pnpm --filter frontend run fund 0xあなたのアドレス
   ```
   `apps/client/.env` の資金済み口座から 5 ℏ を送金し、`0.0.X` を
   lazy-create する。出力の `Transfer status: SUCCESS` と
   `Hedera account id: 0.0.X` を確認する。
5. 画面の「再確認」を押すと Account id と残高が表示される。この時点の口座は
   **hollow account**（EVM エイリアス経由で作られ、まだ何も署名していない）で、
   オンチェーンに公開鍵が無い。x402 facilitator は mirror node から payer の鍵を
   引いて支払い署名を検証するため、この状態では支払いが弾かれる。
6. 「アカウントを有効化」を押す。ウォレットの鍵で 1 tinybar のトランザクションを
   1 回だけ送信し（ブラウザから gRPC-web で testnet ノードへ直接）、鍵を
   オンチェーンに登録する。完了すると自動で残高表示に戻り、支払いボタンが出る。
7. 「支払って /premium を取得」→ Privy が生ハッシュ署名 →
   レスポンス JSON
   （`{ "message": "Payment settled on Hedera testnet.", "priceTinybars": "1000" }`）
   と Settlement オブジェクトが表示される。
8. 「HashScan で確認」リンク
   （`https://hashscan.io/testnet/transaction/<transaction>`）で
   トランザクションが SUCCESS であることを確認する。

## 仕組み

- `src/x402/privyHederaSigner.ts` が `@x402/hedera` の `ClientHederaSigner` を実装。
  `TransferTransaction` を組み、`keccak256(bodyBytes)` を Privy の
  `secp256k1_sign`（生ハッシュ署名）に渡して 64 バイト r‖s を添付する。
- `src/x402/payPremium.ts` が `@x402/fetch` の `wrapFetchWithPayment` +
  `x402Client` + `ExactHederaScheme` で 402 → 支払い → リトライを実行する
  （`apps/client/src/index.ts` と同じ経路）。
- 口座は `src/hedera/resolveAccount.ts` が mirror node で EVM アドレスから解決する。
  レスポンスの `key` が空なら hollow account と判定する（`hasKey: false`）。
- `src/hedera/activateAccount.ts` が hollow account を有効化する。1 tinybar の
  自己トランザクションをウォレットの鍵で署名し、SDK の gRPC-web クライアントで
  testnet ノードへ直接送信する（アプリ内で consensus ノードに触れる唯一の箇所。
  支払い経路はすべてオフライン）。
- 公開鍵は `src/hedera/recoverPublicKey.ts` が署名から secp256k1 公開鍵を復元する。
- `settlementTxId` は `SettleResponse.transaction`（決済トランザクション ID）を読む。
