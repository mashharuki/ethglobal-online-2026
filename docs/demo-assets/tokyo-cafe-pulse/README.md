# Tokyo Cafe Pulse — デモ素材

全レコードは架空の合成データです。実在の店舗・個人の情報ではありません。
この公開リポジトリにも平文を置くため、データ自体の秘密性・独占性は主張せず、決済とアクセス制御の動作をデモします。

| ファイル | 用途 |
| --- | --- |
| `preview.png` | 公開プレビュー画像。IPFSへアップロードして preview URI に指定 |
| `preview.json` | AI向け公開プレビュー。説明・列定義・3件のサンプル。画像の代わりに preview URI に指定可能 |
| `dataset.json` | Creator画面で選ぶ暗号化前のデータ。30日 × 3地区 = 90件 |
| `manifest.template.json` | Manifest構造の記入例。プレースホルダーがあり、そのままMintには使用不可 |

## Creator画面への入力例

- Name: `Tokyo Cafe Pulse`
- Price: `0.1` HBAR（テストネットのデモ価格）
- Duration: `3600` 秒
- Max uses: `3`
- Transfer mode: `SURVIVE_TRANSFER`
- Creator share: `7000` bps（70%）
- Commercial use / AI training: false
- Derivative generation: true

## URIを作る手順

画面内のPinataアップロードには、Gatewayへの `PINATA_JWT` secret設定とGateway/Webの更新反映が必要です。詳細は `apps/gateway/CONFIG.md` を参照してください。

1. Creator画面でログインし、`dataset.json` を選択して暗号化する。この後、作業完了までリロードやファイル再選択をしない。
2. 公開プレビューのファイル欄で `preview.png` または `preview.json` を選んでアップロードする。preview URIが自動入力される。
3. 暗号化済み本体のアップロードを実行する。`content.enc` が送信され、encrypted content URIが自動入力される。元の `dataset.json` はこの操作では送信しない。
4. 価格・利用条件を確認してtokenIdを予測し、Manifestをアップロードする。manifest URIが自動入力される。
5. 鍵情報をローカルにダウンロードする。`shares.json` をGateway運営者へ安全に渡し、`apps/gateway/scripts/load-shares.ts` で登録してもらう。鍵情報をIPFSやGitHubに公開しない。
6. Mintを実行する。tokenId変更が検出された場合は、画面の指示に従ってManifestを再生成・再アップロードする。

Pinata未設定時は、暗号文を単独でダウンロードして外部サービスからアップロードし、URIを手入力する操作も可能です。Manifestは必ず本物の暗号文URIを設定してから生成してください。

`manifest.template.json` は構造の説明用です。assetId、contentHash、conditionsHash、nftContract、tokenIdはCreator画面が実データ・接続先から生成する値を使います。CID・コントラクト情報をこの素材だけから捏造することはできません。

## AI分析用プロンプト

このデータは架空のデモ用です。地区別の来客数と推定売上（visitors × avgSpendJpy）を集計し、平日と週末の平均来客数を比較してください。その結果を根拠に、架空のカフェ出店候補を1地区提案してください。売上は推定値であり、実際の市場データに基づく判断ではないことを明記してください。

## 生成について

JSONは固定乱数シード `20260911` で生成し、件数・日付と地区の一意性・数値範囲・JSON構文を確認しました。画像は組み込みimage_genで生成。使用プロンプトは `image-prompt.txt` に保存しています。
