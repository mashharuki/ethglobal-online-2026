# Creator の Pinata アップロード導線

## 要求と対象範囲

2026-09-11 のユーザー依頼に基づく T110 の改善。Creator画面からPinata SDKを使って公開プレビュー、暗号化済み本体、Rights Manifestをアップロードし、URIを自動入力する。従来の外部アップロード・URI手入力も利用可能とする。

現状は `content.enc` をダウンロードするためにManifestのURI検証が先に必要で、仮URI入力が発生する。この循環を解消し、暗号文だけを単独でダウンロード・アップロードできるようにする。

## 設計

- Gateway: Privy access tokenを検証した利用者に、Pinata SDKから短命のPublic IPFSアップロードURLを発行する。Pinata JWTはWorkers secret `PINATA_JWT` として保持し、ブラウザへ返さない。
- Web: SDKの署名付きURLを使い、ファイルをブラウザからPinataへ直接アップロードする。APIはOpenAPIに定義し、生成型でGatewayとWebを接続する。
- 公開プレビューはユーザーが明示的に選ぶ画像またはJSON。本体の入力ファイルと選択欄を分ける。
- 本体は既存 `encryptDataset` の暗号文バイト列のみを送る。暗号化方式・contentHashの算出・復号経路は変更しない。
- 本体のCID取得後に既存のtokenId予測・`buildManifest` を用い、生成したManifestをアップロードする。仮のCIDをMintしない。
- `shares.json` は別のローカルダウンロード操作と既存 `load-shares.ts` による運営者登録を維持する。Pinataへ送らない。
- アップロード中の競合と古い応答の反映を防ぐ。データ・ポリシー・URI・予測tokenIdの変更後に以前のManifestをMintできないよう失効させる。

## 境界条件

- URL有効期間は60秒。署名付きURLは有効期間中のBearer capabilityであり、単回使用であるとは主張しない。
- 用途を `preview` / `encrypted-content` / `manifest` に限定する。サイズ上限の設計値はそれぞれ10 MiB / 25 MiB / 256 KiB。サーバーがMIME許可リスト・上限を署名URLへ固定する。
- 発行APIは小さいJSONリクエストに限定し、未認証・不正トークン・不正用途・過大サイズを拒否する。Pinata未設定は503で案内する。
- IP単位および検証済みprincipal単位に発行頻度を制限する。既存のisolate内レート制限は補助的な対策であり、全体の保存容量・課金の厳密な上限ではない。
- MIME制約は暗号化済みであることのサーバー側証明にはならない。正規のUIは暗号文だけを本体として送るが、ログイン済み利用者による署名URLの悪用まで完全に防ぐものではない。
- 署名URLのレスポンスは `Cache-Control: no-store`。JWT・URL・鍵情報をログやエラー本文へ含めない。

## Constitution Check

- I / II: 二つのEpoch・オンチェーン認可・移転時の権利処理を変更しない。
- III: 実行経路は実Pinata SDKと実APIを使用する。境界の通信を置換する自動テストはライブ統合完了の証拠として扱わない。
- IV: 未認証・不正入力・上限超過・アップロード失敗・古いManifestの利用について、ガードと同じ変更でテストを用意する。
- V / VI: Receiptや鍵配布方式は変更しない。平文の本体・復号鍵・sharesは公開ストレージへ送らない。
- VII: Pinata資格情報の設定と実アップロードが未実施なら、その旨を明記する。ホスト済み画面への反映とローカル実装完了を区別する。

## 選定理由と代替案

ユーザー指定の公式 `pinata` SDKを採用する。Gatewayで短命URLを発行する方式は、ブラウザへの長期JWT配布を避け、大きなファイルをWorkerが中継する必要もない。代替のWorker経由multipart中継は検査しやすいが、転送・メモリ負荷が増える。従来の手動アップロードはフォールバックとして残す。

参考: https://docs.pinata.cloud/sdk/upload/public/create-signed-url / https://docs.pinata.cloud/frameworks/hono

## 受け入れ確認

- プレビュー → 暗号文 → Manifestの順に画面からアップロードでき、各URIが自動入力される。
- 不正トークンや不正なアップロード指定はPinata URL発行前に拒否される。
- 失敗時には再試行でき、古いManifestや別ファイルのCIDでMintできない。
- 生成型の再生成、関連テスト、Gateway型チェック、Webビルド、変更対象のlintを実施する。
- ライブ確認にはPinata secretの設定とGateway/Webの反映が必要。テストでの成功だけをライブ成功とは報告しない。
