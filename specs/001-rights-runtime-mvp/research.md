# Phase 0 リサーチ: Transfer-Coupled Rights Runtime MVP

**対象**: `plan.md` の Technical Context にある NEEDS CLARIFICATION（R-1〜R-6）と主要技術選定の根拠。

各項目は **Decision（決定）／ Rationale（根拠）／ Alternatives considered（検討した代替案）** の形式。day1 に実地検証すべきものは「⚠ day1 検証」を付す。

---

## R-1: KeyGate の鍵分割構成

### Decision

コンテンツ資産ごとに：

- 乱数の **content key `K`（256bit）** で本体を `AES-256-GCM` 暗号化（クライアント側、Creator Console）。
- `K = share_G XOR share_U`（どちらも 32 バイト、`share_U = K XOR share_G`）。
- **`share_G`**：Access Gateway が **PostgreSQL に保管**（列は KEK で暗号化）。オンチェーン認可チェック通過後にのみ TLS で放出。
- **`share_U`**：**DB には置かず、KMS / Secrets Manager（本番相当は AWS KMS、ローカルは sops / age 暗号ファイル）に保管**。Gateway は購入時 / 所有者初回認証時に **一時的にのみ** `share_U` を参照し、当該ウォレット向けの **blinded share** を計算して DB に格納したら、`share_U` の平文をメモリから破棄する。
  - `blindedU[asset, wallet] = share_U XOR HKDF-SHA256(sig_wallet, info="truenft/keygate/v1/<assetId>")`
  - `sig_wallet` = そのウォレットが固定 EIP-712 チャレンジ `KeyGateChallenge{assetId, purpose}` に署名した決定的署名（secp256k1 + RFC6979）。
- **クライアント側の復元**：`share_U' = blindedU XOR HKDF(sig_wallet)` → `K = share_G XOR share_U'` → `AES-256-GCM` 復号。すべてブラウザ / Agent プロセス内で完結。Gateway は `K`・平文を保持しない。

**所有者パス**：`blindedU` は「所有者が初めて `POST /owner/keygate` に成功した時点」で計算・キャッシュする（`accessEpoch` 付きで）。NFT 移転後、新所有者が初回認証すると新しい `blindedU` を計算する。**旧所有者の `blindedU` は残っていても、`share_G` が放出されないため無害**（`share_G` 放出は毎回 `ownerOf` / `accessEpoch` の直読みでゲートされる）。

**購入者パス**：`blindedU` は購入完了時（`RightsRegistry.settleAndIssue` 確定後）に licensee 向けに 1 回計算する。licensee は固定なので移転の影響を受けない。

### R-1a: 認証チャレンジと鍵導出チャレンジの分離（2026-09-05 マルチモデルレビュー対応・Critical）

**問題（Codex #6 High／Fable C-3 Critical、独立に一致した指摘）**：上記の `sig_wallet`（`KeyGateChallenge` への署名）は固定・nonce なしのため、それ自体が (a) 鍵導出素材であり (b) `/owner/keygate` `/keygate/share` の**認証**にも使われている。結果、Gateway はリクエスト処理中に `sig_wallet` + `blindedU`（DB）+ `share_G`（KV）を同時に扱い得る（「Gateway は `K` を保持しない」は at-rest の話に限られ、リクエスト処理中・ログ・例外スタックトレースには残り得る）。さらに固定チャレンジのため、`sig_wallet` を 1 度でも入手した第三者は無期限にリプレイして licensee になりすませる（`/keygate/share` の再送で残り利用回数を消費させる griefing も可能）。

**Decision（修正）**：**認証用の署名と鍵導出用の署名を分離する。**
- **認証**：`OwnerAuthChallenge` と同型の nonce 付きチャレンジを licensee パスにも導入する — `LicenseeAuthChallenge{ nonce: bytes32, chainId: uint256, receiptHash: bytes32, expiresAt: uint64 }`（`auth_nonce` の既存 `purpose='keygate-challenge'` をこれに charge する）。`/keygate/share` は今後この認証署名を**必須**とし、`keyGateSig`（鍵導出用の固定署名）は認証には使わない。
- **鍵導出**：`KeyGateChallenge` への署名（`sig_wallet`）はこれまでどおり `blindedU` の計算にのみ使うが、**クライアントから毎回送らせない**。`blindedU` は「初回アクセス時（購入完了直後 or 所有者の初回認証成功時）」の 1 回だけ計算・保存し、以降のアクセスは nonce 付き認証署名のみで完結させる（`share_U` そのものではなく `blindedU`＝`share_U XOR HKDF(sig_wallet)` を保存する既存設計は変えない）。
- ログ・監査記録（`audit_log`）には `keyGateSig` / `sig_wallet` を一切書き込まない（既存の `authSig` も同様）。

**Rationale**：これにより、通常のリクエストログ・エラーログから漏れうるのは nonce 付きの使い捨て認証署名のみとなり、鍵導出素材（`sig_wallet`）はリクエストのライフサイクル外に出ない。「licensee パスは憲章 VI 完全準拠」という `plan.md` の主張が実装レベルでも成立する。

**Alternatives considered**：署名の代わりに API キー発行 → 鍵配布の別チャネルが増え MVP には過剰。両チャレンジを 1 本のまま nonce だけ足す → 鍵導出値が nonce ごとに変わってしまい `blindedU` の再利用ができなくなる（購入のたびに違う `K` になり破綻）ため、2 チャレンジへの分離が必須。

### Rationale

- **憲章 VI の「仲介者が保持する部分だけでは平文へ復号できない」を DB 単位で満たす**：DB 全体が漏洩しても、攻撃者が得るのは `share_G` と `blindedU`（＝`share_U XOR HKDF(sig)`）のみ。`share_U` も `sig_wallet` も無いため `K` を復元できない。
- **`share_U` の KMS 分離が「production では分散化」の具体的な起点**：MVP は KMS 1 か所、production は `share_U` を Shamir 2-of-3 でオペレータ 3 ノードへ（`docs/idea.md` v1.4 の stretch）。設計インターフェース `KeyGate.getShareU()` を差し替えるだけ。
- **移転時に再暗号化不要**（FR-015）：`K` も暗号文も不変。変わるのは「`share_G` を放出するかどうか」のオンチェーン判定だけ。
- **決定的署名で鍵導出**：Privy 内蔵ウォレット（EOA）は `personal_sign` / EIP-712 署名が RFC6979 で決定的。ウォレットを跨いで安定した鍵素材が得られる（Lit の authSig や類似 dApp と同じ確立パターン）。

### Alternatives considered

| 代替案 | 却下理由 |
|---|---|
| `share_U` を Rights Manifest に平文で公開し、セキュリティは `share_G` ゲートのみに依存 | Gateway が `share_G` + 公開 `share_U` の両方を持つ = 実質「信頼ゲートウェイ」。憲章 VI 不成立 |
| Lit Protocol / TACo / iExec などの分散鍵ネットワーク | `docs/idea.md` v1.4：Lit は Datil→Naga→v3 で不安定、いずれも Hedera 非対応。ハッカソン期間にリスク過大 |
| 移転時に旧所有者が新所有者へ `K` を再ラップ（Proxy Re-Encryption 相当） | FR-015 が明示的に禁止。SignCast と同じ土俵に戻る（`docs/idea.md` §14.3） |
| `share_G` を最初から Shamir 2-of-3（3 ノード） | MVP には過剰。フォールバック（短命署名 URL）→ 本命 XOR 2-of-2 → stretch で Shamir、という段階設計（`docs/idea.md` v1.4）に従う |
| ウォレット署名から `K` を直接導出（Gateway 不要） | オンチェーンの権利状態（`ownerEpoch` / `licenseEpoch` / consume）でゲートできない。中心命題が消える |

### フォールバック（Day1 に最初に動かす、`docs/idea.md` v1.4 段階設計）

Gateway が認可チェック後に **短命署名 URL** または復号済みストリームを返す素の方式。「暗号化パートは常に動く」保証。KeyGate 本命が間に合わなければこれで提出し、信頼モデル段落で「この構成では Gateway が平文を扱う」と開示する（`plan.md` Complexity Tracking にも条件付き逸脱として記録）。**タスク化：`apps/gateway/src/keygate/fallback.ts`（tasks.md T077）**。

### 憲章 VI との関係

- **licensee パス**：`blinded_U` が licensee 署名に束縛され、`share_U` は発行時のみ一時参照して破棄 → Gateway の永続データ（KV `share_G` + DB `blinded_U`）単体では復号不能。**憲章 VI 準拠**。
- **owner パス**：新所有者が随時現れるため `share_U` を Workers Secrets Store に保持し Gateway が再取得可能 → Gateway デプロイの完全侵害で平文が復元されうる。憲章 VI の「仲介者が保持する部分単独では復号に無意味でなければならない（MUST）」を **owner パスでは満たさない**。
- **対応**：`plan.md` Complexity Tracking に逸脱として記録し、README（T123）・no-mocks 監査（T122）で開示。production は `share_U` を独立オペレータ 3 ノードの Shamir 2-of-3 に分散（v1.4 stretch。I/F `KeyGate.getShareU()` の差し替えのみ）。

---

## R-2: Hedera 上での x402 決済と `RevenueAllocation` / `ReceiptIssued` の原子性

### Decision

**決済資産 ＝ ネイティブ HBAR（USDC ではない）。** Hedera「AI & Agentic Payments」トラックで必須の **Blocky402 facilitator**（`https://api.testnet.blocky402.com`）の `/supported` は次を返す（2026-09-04 確認）：

```json
{ "kinds": [
    { "x402Version": 2, "scheme": "exact", "network": "eip155:80002" },
    { "x402Version": 2, "scheme": "exact", "network": "solana:…", "extra": { "feePayer": "…" } },
    { "x402Version": 2, "scheme": "exact", "network": "hedera:testnet", "extra": { "feePayer": "0.0.7162784" } }
  ],
  "signers": { "eip155:*": ["0xDCF7D72C2eE049DE4269ac6AAf925F33efdA18de"],
               "solana:*": ["7B6Q2MvcJvNcy1A13wHmAzmmdo3L8DVriaXML7bvkojm"],
               "hedera:*": ["0.0.7162784"] } }
```

`hedera:testnet` の `exact` に **資産（トークン）の指定がなく**、`feePayer` / `signer` は Hedera アカウント `0.0.7162784`。HTS の Testnet USDC（`0.0.429274`）はサポート対象に現れない。→ **x402 の支払い資産を USDC からネイティブ HBAR へ変更する。**

**Primary（目標）**：購入者の x402「exact」ペイロードを **`RightsRegistry.settleAndIssue(...)` への value 付き ContractCall** とし、その関数本体（`payable`）で
1. `require(msg.value == p.price)`（HBAR は tx に添付済み。`UnderPayment`）、
2. `RightsNFT.ownerOf(tokenId)` をその場で読み、`RevenueAllocation` を creator / current owner の claimable（weibar）に記録、
3. `ReceiptIssued(receiptHash, ...)` を emit、

を **1 Hedera トランザクションで原子的に**実行する。Blocky402 が gas を肩代わり（`feePayer 0.0.7162784`）してこの tx を submit する。失敗時は tx 全体が revert し HBAR は移動しない（返金経路不要、憲章 VII / spec Assumptions）。

**⚠ day1 検証（T020）**：Blocky402 の `hedera:testnet` / `exact` が「feePayer 宛の plain native transfer」だけでなく「**native value を添付した ContractCall**」ペイロードを verify / settle できるか。決済メカニズム（`X-PAYMENT` の署名対象、buyer submit か facilitator submit か、`feePayer` の役割、`asset` フィールドで native をどう表すか、`x402Version` 2 の形式）を `/supported` `/verify` `/settle` で確認する。**Blocky402 を経由していることを提出物に明記**（トラック要件）。

**Fallback（primary が facilitator 側で成立しない場合のみ、README に非 trustless 前提を開示）**：
`RightsRegistry.payFor(bytes32 paymentId) payable` に buyer が HBAR を預ける（`pending[paymentId] = {payer, amount, ts}`、それ自体は原子的な native transfer）。直後に **誰でも呼べる** `RightsRegistry.finalize(paymentId, receiptParams)` が `pending` 額とパラメータを検証して allocation + `ReceiptIssued` を確定する。HBAR は常にコントラクト管理下（誰にも custody されない）。`finalize` 未実行で放置されたら `refundUnfinalized(paymentId)` を timeout 後に buyer が呼べる。これは憲章の「Settlement → Claimable → Claim の 3 段」に相当し、**既定ではなくフォールバック**として明示。

**⚠ fallback 採用時の追加ハードニング（2026-09-05 マルチモデルレビュー対応・Codex #2 Critical）**：上記の素朴な `pending[paymentId] = {payer, amount, ts}` は購入内容（`receiptParams`）に一切コミットしていないため、**誰でも呼べる `finalize` が「別人の入金を、finalize 呼び出し者が指定する任意の資産・licensee の収益に転用できる」**（`amount` 一致だけでは防げない。攻撃者が被害者の入金後に、自分が creator/owner である資産を指定して先に `finalize` を呼ぶ）。fallback を実際に採用する場合は必ず次を満たすこと：
- `payFor` 呼び出し時点で `purchaseRequestHash`（または `receiptParams` のハッシュ）を `pending[paymentId]` に固定させる（`payFor(bytes32 paymentId, bytes32 committedParamsHash) payable`）。
- `finalize` は渡された `receiptParams` から同じ規則でハッシュを再計算し、`committedParamsHash` と一致することを require（不一致は revert）。
- 「入金時点」と「finalize 時点」のどちらを収益配分先（`ownerOf` の解決時点）とするかを明示し、`solidity-interfaces.md` の `finalize` の実装ステップに明記する（本 MVP では **finalize 時点の `ownerOf`** を採用し、A-5 の primary と同じ規則にする）。

いずれの場合も **Claim は Pull 型**：`RightsRegistry.claim()`（`nonReentrant`、CEI）が呼び出し元の確定済み claimable を **ネイティブ HBAR** で払い出すのみ。所有者の再解決はしない（FR-009 / FR-010 / A-5）。

### R-2a: 決済レールが primary・fallback 双方とも同一の未検証仮定を共有している問題（2026-09-05 マルチモデルレビュー対応・Critical）

**問題（Codex #4 High／Fable C-2 Critical、独立に一致した指摘）**：primary（`settleAndIssue{value}` への value 付き ContractCall）と fallback（`payFor{value}`）は、どちらも「Blocky402 が value 付き ContractCall（任意 calldata を伴う HBAR 送金）を verify/settle できる」ことを前提にしている。しかし `/supported` の応答（`hedera:testnet` の `extra.feePayer`）は、Solana エントリと同型の構造であり、**Blocky402 の Hedera 実装が実際には「buyer 署名の HAPI CryptoTransfer を facilitator が feePayer として submit するだけ（plain native transfer 限定）」である可能性を排除できない**。この場合、primary・fallback のどちらも成立せず、9 日プランの決済まわり全体（Phase 3 の contracts 設計・Phase 7 の x402 実装）が崩れる。

**Decision（対応）**：
1. **T020（day1 probe）の検証範囲を拡張**：「`settleAndIssue{value}` 相当の ContractCall」だけでなく「`payFor{value}` 相当の ContractCall」も同時に検証し、1 回の probe で primary・fallback 双方の可否を確定する（tasks.md T020 に反映）。
2. **第 3 案（非原子・カストディ型フォールバック）を day1 のうちに文書化しておく**：primary・fallback のどちらの ContractCall も成立しない場合、buyer は x402 の plain native transfer で **Gateway 決済用アカウント**（`HEDERA_OPERATOR_KEY` とは別の、決済受領専用アカウント）へ HBAR を送金し、facilitator の settle 応答（tx id）を Gateway が確認した後、**Gateway オペレータが自己の gas で `settleAndIssue{value}` を呼んで allocation を確定**する。この経路は非原子（決済 tx と `ReceiptIssued` tx が別）かつ Gateway が一時的に資金を経由する（custody）ため、README（T123）で「決済と anchor は非原子」「Gateway が決済受領を仲介する」の両方を明示開示する（憲章の「やむを得ず…限り」条項に該当）。
3. この第 3 案は `ReceiptParams` 構造・`settleAndIssue` の実装を変更しない（呼び出し元が Gateway オペレータになるだけ）ため、primary を前提に進めている Phase 3 の contracts 実装が無駄にならない。

**Rationale**：day1 の 1 回の probe で 3 択（primary / fallback / 第 3 案）が出揃うようにしておけば、09-04 終業の hard gate で確実にどれかへ倒せる。第 3 案を「思いついてから書く」のではなく先に文書化しておくことで、tripwire 発動時の設計変更コストをゼロに近づける。

### Rationale

- 憲章「settlement は決済と同一トランザクションで原子的に確定する（MUST）。…この原子性が技術的に成立しない構成へやむを得ず変更する場合に *限り* … フォールバック」に厳密に沿う。primary を諦める前に day1 で必ず検証する。
- **ネイティブ HBAR は HTS の allowance / association / ERC-3009 をすべて回避できる**：`transferFrom` も `approve` も不要、association 漏れの事故もない。`settleAndIssue` を `payable` にして `msg.value` を受けるだけで primary が成立しやすくなる（USDC HTS より primary の見込みが高い）。
- `ownerOf` を settle と同じ tx 内で読むことで、「NFT 移転と Claim の間の再移転で受取人が変わる」曖昧さ（Pull 型特有）を排除（A-5、`docs/idea.md` §6.5）。
- primary が動くと「権利 anchor ＝決済トランザクションそのもの」になり、Ethereum（Hedera）の必然性（DoD #2）が強化される。
- **精度**：Hedera EVM の `msg.value` は weibar（10^18 = 1 HBAR）だが native 精度下限は tinybar（10^8）。金額は 10^10 weibar の倍数に制約し、`RevenueLib` の `mulDiv` 端数は treasury（未設定なら creator）へ寄せて dust 0 を保証（R-4 / SC-006）。

### Alternatives considered

| 代替案 | 却下理由 |
|---|---|
| **USDC（HTS `0.0.429274`）で決済**（当初案） | **Blocky402 の `/supported` が `hedera:testnet` で HTS トークンを advertise しない**（native のみ）。トラック必須の facilitator が扱えないため不成立。加えて HTS の allowance / association / ERC-3009 非対応の複雑さ（旧 R-4） |
| 独自 mock ERC-20 / 独自安定トークンをデプロイ | 憲章 III「コア経路にモック禁止」。Blocky402 が任意トークンを扱う保証もない |
| Gateway オペレータ EOA が HBAR を受領し、別 tx で on-chain 記録、Claim は Gateway が払い出し | Gateway が資金を custody する信頼点。憲章の原子性要件から最も遠い。「支払い受領」が tx 外 |
| Hedera Scheduled Transaction で複数操作をまとめる | 「同一 tx の原子性」ではなく「予約実行」。revert 挙動が EVM の 1 tx と異なり、設計が複雑化 |
| 決済をオフチェーン（Stripe 等）にして on-chain は記録のみ | x402 / AI Agent 決済という中心的な訴求が消える。Hedera の Agentic Payments トラック要件も外れる |

---

## R-3: Receipt 消費の並行制御（憲章 II と 憲章 V の両立）

### Decision

**三層の防御**（外側から）：

1. **Durable Object `ReceiptLock`（アプリ層の直列化）**：`POST /keygate/share`（購入者パス）は `env.RECEIPT_LOCK.get(idFromName(receiptHash))` にルーティングされる。DO は単一スレッドでリクエストを直列処理し、`useIndex` の払い出し（現在の `usedCount` をオンチェーン `eth_call` で読む）→ オンチェーン `consume` tx の送出 → 確定待ち を 1 リクエストずつ行う。同一 `receiptHash` への 20 並列は DO 内で 1 本のキューになる。
2. **PostgreSQL（Hyperdrive、defense-in-depth + 監査）**：DO が `consume` 前に `BEGIN; SELECT ... FOR UPDATE receipt_consumption WHERE receipt_hash=$1; INSERT INTO receipt_consumption(receipt_hash, use_index, ...); COMMIT`（`UNIQUE(receipt_hash, use_index)`）。DO を跨いだ想定外（例：`wrangler` の再デプロイで DO が入れ替わる瞬間）や複数リージョンの競合を DB 制約が拾う。
3. **オンチェーン `RightsRegistry.consume`（最終権威）**：`consumed[receiptHash][useIndex]` と `usedCount < maxUses` をチェックして revert / emit。Hedera の合意順序で 20 並列 tx のうち 1 つだけ成功。**Gateway をバイパスして直接コントラクトを叩く攻撃**もここで止まる。

**認可の権威はオンチェーン**（`receiptStatus` + `hasValidConsumption`）。DO と DB は「Gateway が同一 `useIndex` に複数 tx を投げない」ための重複防止であって、`share_G` 放出の可否判断はオンチェーン読み取りで行う（憲章 II）。`share_G` は **オンチェーン `consume` tx 確定後**に放出（settle-before-release、憲章 V）。SC-002（p50 < 20s）は Hedera finality 3–5s を含めて収まる。SC-005（判定 < 3s）は DO のキューイング + Hedera の高速 finality で満たす。

### Rationale

- **Durable Object は憲章の「原子的なスクリプト」に相当する**：憲章 V/セキュリティ要件は「DB トランザクション **または** 原子的な Lua スクリプト」を許容する。DO の単一スレッド直列実行はそれと同等かそれ以上に強い保証で、`receiptHash` を鍵にした自然なシャーディングになる。
- **憲章 II 不変**：バックエンドが Workers になっても、`share_G` 放出前に `viem` で `receiptStatus` / `hasValidConsumption` / `ownerOf` / `accessEpoch` を Hedera relay に `eth_call` する点は変わらない。
- **憲章 V の DB 制約要件も維持**：Hyperdrive 経由で通常の Postgres（Neon/Supabase）に接続でき、`SELECT ... FOR UPDATE` と `UNIQUE` 制約はそのまま使える。
- Concurrent Replay（SC-005）を **DO / DB / contract の 3 層でテスト**できる（憲章 IV、実 20 並列。`@cloudflare/vitest-pool-workers` で DO を、Hardhat で contract を）。

### Alternatives considered

| 代替案 | 却下理由 |
|---|---|
| Node プロセス + `SELECT ... FOR UPDATE` のみ（当初案） | 単一プロセス前提。水平スケールや再デプロイ中の競合に弱い。DO の方が「1 Receipt = 1 直列キュー」が明示的で正しい |
| DB 原子ロックのみ（オンチェーン consume なし） | 認可の権威が DB になり憲章 II 違反。Gateway バイパス攻撃に無防備。The Graph が消費を index できない |
| オンチェーン consume のみ（DO / DB なし） | Gateway が同一リクエストで複数 tx を投げる実装バグに脆弱。憲章 V の DB 制約要件も未達 |
| Redis の atomic Lua スクリプト | Workers から使うなら Upstash 等の追加サービス。DO で完結する方がインフラが減る |

### R-3a: `useIndex` のオンチェーン直読み依存・consume 権限・クラッシュ復旧（2026-09-05 マルチモデルレビュー対応・High）

**問題1（Codex #9／Fable H-4、独立に一致）**：Hedera JSON-RPC relay の `eth_call` は mirror node（record stream を数秒遅れで取り込む indexer）に対して実行されるため、`useIndex := usedCount`（オンチェーン `eth_call` から都度導出）は直前の `consume` 確定直後に数秒間古い値を返しうる。2 リクエストが短時間に連続すると同一 `useIndex` を採番し、片方が DB `UNIQUE` 衝突で不必要に拒否される。

**Decision（修正）**：`useIndex` は `eth_call` から都度導出せず、**`ReceiptLock` DO 自身が `receiptHash` ごとの次採番カウンタを保持**する。DO 起動（コールドスタート）時のみ `eth_call usedCount` で初期化し、以降は DO のメモリ / storage 上のカウンタをインクリメントして採番する（`consume` tx の revert / 未確定を検知したら reconcile）。

**問題2（Codex #8／Fable H-5、独立に一致）**：`consume(receiptHash, useIndex)` は「Gateway のオペレータ鍵が呼ぶ」という運用上の前提だけで、コントラクト側にアクセス制御がない。`receiptHash` は `ReceiptIssued` イベントで公開されるため、第三者が直接 `consume` を呼んで正規購入者の `usedCount` を消費し尽くせる（griefing、gas 代のみで実行可能）。

**Decision（修正）**：`consume` に `onlyOperator`（`HEDERA_OPERATOR_KEY` のアドレス限定）を追加する。既存の `NotAuthorized` custom error をこの用途に使う（`solidity-interfaces.md` に反映）。

**問題3（Codex #10／Fable H-6、独立に一致）**：`receipt_consumption` の `status='locked'` から `consume` tx submit までの間に Worker/DO がクラッシュすると、(a) tx 未送信ならオンチェーン `usedCount` は不変だが同じ `useIndex` で `UNIQUE` 衝突 → 恒久的に `RECEIPT_ALREADY_CONSUMED`。(b) tx が実は mined 済みで `status` 更新前に落ちると、支払済みの 1 回分の `share_G` が配信されないまま消える。

**Decision（修正）**：`UNIQUE` 衝突時、既存行が `status='locked'` かつ一定時間（60秒）を超えていたら、**まずオンチェーンの `consumed[receiptHash][useIndex]` を直接確認**する。`true` なら行を `settled` に補正して既存の再配信規則（5分 TTL）に乗せる、`false` なら行を `failed` にして同一 `useIndex` で `consume` を再送する（`data-model.md` の `receipt_consumption` 状態遷移を拡張）。

**問題4（Fable H-12、Codexは未指摘）**：`ReceiptLock` DO は `receiptHash` 単位で直列化されるが、`consume` tx の送信自体は共通の `HEDERA_OPERATOR_KEY` から行われる。異なる `receiptHash`（例：buyer と別の agent が同時に別資産を復号）が別々の DO から同時に tx を送ると、nonce 採番（`eth_getTransactionCount`）が競合し、片方が `nonce too low` で失敗しうる。

**Decision（修正）**：tx の送出を単一の `OperatorTxQueue` Durable Object に集約し、そこで nonce を採番して逐次送信する。`ReceiptLock` DO は `useIndex` の採番と `consume` 呼び出しの依頼のみを行い、実際の tx 送信は `OperatorTxQueue` に委譲する（`apps/gateway/src/do/OperatorTxQueue.ts` として新設、tasks.md T083 に反映）。

---

## R-4: Hedera EVM でのネイティブ HBAR value の扱い（旧「USDC HTS ファサード」を改訂）

> 決済資産を USDC → ネイティブ HBAR に変更（R-2、Blocky402 `/supported` の制約）。本節は旧「HTS `transferFrom` / allowance / association / 6 桁小数」の検討を撤回し、ネイティブ value の検討に差し替える。

### Decision

- 決済は **ネイティブ HBAR**。`RightsRegistry.settleAndIssue` を `payable` にし、`require(msg.value == p.price)` で受領（`UnderPayment`）。HTS system contract（`0x167`）・トークン EVM アドレス・`transferFrom` / `approve` / `associate` は **一切使わない**。
- **単位（2026-09-05 マルチモデルレビュー対応・Fable H-7 により改訂）**：Hedera EVM の `msg.value` は EVM 境界では weibar（10^18 = 1 HBAR）表現で届くが、**コントラクト内部の会計（`price` パラメータ・`claimable`・`allocationOf` の金額）は全て tinybar（10^8 = 1 HBAR）単位で保持する**。`msg.value` を受け取った直後に `priceTinybar = msg.value / 1e10` へ変換し（Hedera の native 精度下限が tinybar であるため、weibar のまま扱うと `mulDiv` の按分結果が 10^10 の倍数から外れ、tinybar 境界に乗らない値が生成されて `claim()` の `.call{value:}` が失敗するか下位桁が切り捨てられる — 旧設計の欠陥）、以降の按分・`claimable` 加算・払い出しはすべて tinybar 単位の整数で行う。払い出し時にのみ `.call{value: claimableTinybar * 1e10}` で weibar へ戻す。
- `RightsManifest.paidAccess.price` は引き続き weibar の整数文字列（人間可読・UI 表示用）で表現するが、**10^10 weibar（= 1 tinybar）の倍数であることを zod スキーマで強制**し、コントラクトへ渡す前に `priceTinybar` へ変換する（`packages/shared/src/manifest.ts`）。
- **分配**（SC-006 / FR-022）：`RevenueLib` で `creatorAmountTinybar = mulDiv(priceTinybar, creatorBps, 10000)` / `ownerAmountTinybar = mulDiv(priceTinybar, ownerBps, 10000)` / `dustTinybar = priceTinybar - creatorAmountTinybar - ownerAmountTinybar` を計算し、`dustTinybar` を `creator` の claimable へ寄せる（M-4 対応、treasury は導入しない。下記「マルチモデルレビュー対応」参照）。tinybar は整数単位のため `mulDiv` の丸めは常にちょうど tinybar 境界に乗り、精度ロスが発生しない。
- **払い出し**：`claim()` / `refundUnfinalized()` は `PayLib.sendValue`（`claimableTinybar * 1e10` を `to.call{value:}` + 失敗 revert）。`RightsRegistry` は `ReentrancyGuard` を継承し CEI 順（`claimable` ゼロ化 → 送金）。受領側の EOA には association 概念がないためそのまま届く。
- **⚠ day1 検証（T018）**：最小 `payable` コントラクトで、`msg.value` が weibar で来ること／`payable` 関数への value 添付／`msg.value / 1e10` が期待どおり tinybar 整数になること／tinybar 単位の `mulDiv` 分配で dust が想定内（常に 0〜数 tinybar）／`.call{value:}` の成功・失敗ハンドリング／10^10 未満の端数を送ったときの挙動、を実 Testnet で確認。

### Rationale

- Hedera の EVM 互換は「Ethereum そのものではない」（`hedra-sample` README）。**ネイティブ value 転送は HTS 特有の allowance / association / ERC-3009 をすべて回避**でき、デモの資金フロー（buyer → registry → creator/owner）で事故りやすい association 漏れが構造的に消える。
- `payable` + `msg.value` は x402「exact」の ContractCall に最も載せやすく、R-2 primary の成立見込みが USDC HTS より高い。
- **会計を tinybar 単位にすることで、weibar 建て会計が抱えていた「按分結果が tinybar 境界に乗らず claim が失敗するか dust が滞留する」問題を構造的に解消する**（Fable H-7）。weibar はコントラクト境界（`msg.value` / `.call{value:}`）でのみ現れる表現であり、内部会計には持ち込まない。

### Alternatives considered

| 代替案 | 却下理由 |
|---|---|
| USDC（HTS `0.0.429274`）を EVM ファサードで `transferFrom` | Blocky402 `/supported` が `hedera:testnet` で native のみ。トラック必須 facilitator が扱えない（R-2）。allowance / association / ERC-3009 非対応の複雑さも |
| 価格を tinybar（10^8）建てにして contract 内で weibar 変換 | 変換ミスの温床。`msg.value` と同じ weibar に統一し、倍数制約 + dust 規則で扱う方が単純 |
| `msg.value >= price` を許容し overpay を claimable に載せる | x402「exact」は正確な額を保証する。`==` にして仕様に忠実にする（overpay は facilitator 側で弾かれる想定） |

---

## R-5: Rights Graph（subgraph）の Hedera Testnet デプロイ — 自前 Graph Node 一択

### Decision

- **The Graph の賞トラックには submit しない。** 2026-09-04 確認：**Hedera は Subgraph Studio / The Graph Market / The Graph Network に非対応**（[Hedera 公式](https://docs.hedera.com/evm/tools/other/the-graph)：hosted service unavailable → 自前 graph node が必須）。**The Graph Token API も Hedera 非対応**。ETHOnline の The Graph 両トラックは要件が「**Consume live data from a Graph provider（Subgraph Studio / The Graph Market）。Mocked, local-only, or static datasets do not qualify.**」で、自前ホスト Graph Node は "local-only / not a Graph provider" として要件を満たさない。→ **submit 対象は Hedera + Privy×2 に確定**（`docs/idea.md` §16、憲章 v1.2.0）。
- **Rights Graph 自体は維持**：`hedra-sample/hedera-subgraph-example` 構成（`specVersion 0.0.4` / `apiVersion 0.0.6` / `network: testnet` / wasm mappings）で、データソースは `RightsNFT`（`Transfer`, `PolicyUpdated`）と `RightsRegistry`（`ReceiptIssued`, `ReceiptConsumed`, `RevenueAllocated`, `LicenseEpochBumped`）。**Agent の資産発見（FR-020）と Dashboard の監査ビューに使う load-bearing な技術要素**。
- **デプロイ先＝自前 Graph Node（`apps/cdk` で AWS へ、ハッカソン期間のみ）**：**AWS CDK（TypeScript、`aws-cdk-lib` 2.x）で `GraphNodeStack` を定義** ― EC2 1 台 + Elastic IP + Security Group + EBS、user-data で `docker compose up`（`graph-node` + PostgreSQL + IPFS の 3 コンテナ、Hedera JSON-RPC relay を `ethereum` プロバイダに設定）。`startBlock` は `deploy.ts` がデプロイ tx の block number を `subgraph.template.yaml` に注入。**ハッカソン終了後は `cdk destroy` で撤去**。EC2 + docker-compose を選んだ理由：既存の `hedra-sample/hedera-subgraph-example` の compose 定義をそのまま載せられて最速・最安、停止も一発。ECS Fargate は CDK 記述量・コスト・起動時間が増えるため却下。
- **⚠ day1 検証（T021）**：(1) Subgraph Studio の Hedera 対応を再確認（万一対応済みなら submit 対象を再検討）。(2) 非対応前提で `cdk deploy`（最小版）→ `hedra-sample/hedera-subgraph-example` の手順で最小 subgraph をデプロイ・クエリまで通す。EC2 インスタンスタイプ / EBS サイズ / Hedera relay を provider にした同期速度を記録。**本番の GraphNodeStack ビルドは Phase 5（T054–T057）**。

### Rationale

- `hedra-sample` で Hedera×subgraph（ローカル graph node）の動作は検証済み（`docs/idea.md` v1.4）。ゼロから疎通するリスクは無い。ただしその検証は **ローカル graph node** であり、The Graph の賞要件を満たす経路ではなかった（idea §16.4 の「検証済み」表記はこの点で誤解を招くため §16 を訂正）。
- 認可には使わない（FR-020、憲章 II）ため indexing 遅延は許容。Dashboard と Agent の発見にのみ使う。
- Rights Graph を切ると Agent の資産発見（FR-020）が Mirror Node ベースの自前実装になり、二層 epoch の監査ビュー（デモの説得力）も弱る。賞に出さなくても技術要素としては残す価値がある。

### Alternatives considered

| 代替案 | 却下理由 |
|---|---|
| The Graph の賞を狙うため別の Studio 対応チェーンに 2 つ目の subgraph をデプロイ | 「複数チェーン対応」非ゴール（§3.2）に抵触。Hedera のイベントを別チェーンの subgraph で index できない（構造的に不可能）。トークン的な統合は "make the standards leverage clear" を満たせず減点対象 |
| Hedera Mirror Node REST API + 自前インデクサ（subgraph を捨てる） | Agent 発見・監査ビューの実装コストが増える。subgraph は `apps/cdk` の自前ホストでも動くので、まず subgraph を使う。**最終手段のフォールバックとしては設計を残す**（quickstart §4） |
| Graph Node を AWS ECS Fargate で運用 | 3 コンテナをサービス分割・ALB 経由で運用は綺麗だが、CDK 記述量・コスト・起動時間が増える。ハッカソン期間だけの一時インフラには EC2 + docker-compose が最短 |
| The Graph 認可を使う（Gateway が subgraph をクエリして所有権判定） | 憲章 II / FR-020 で明確に禁止 |

---

## R-6: ハッシュの正規化仕様

### Decision

すべて `packages/shared/src/hashing.ts` / `eip712.ts` に単一実装を置き、全レイヤー（contracts の `ReceiptLib` は Solidity で同一ロジックを再実装しテストで一致を検証）が同じ値を出す。

| ハッシュ | 定義 |
|---|---|
| `resourceHash` | `keccak256(abi.encode(nftContract, tokenId, assetId, contentHash))`。`assetId` は資産の一意 ID（`bytes32`）、`contentHash` は暗号文の `keccak256` |
| `policyHash` | `keccak256(abi.encode(price(uint256), duration(uint64), maxUses(uint32), permissions(uint8 ビットフラグ), transferMode(uint8), revenueSplit(creatorBps uint16, ownerBps uint16)))` |
| `conditionsHash` | `keccak256(abi.encode(ownerConditionSelector, licenseConditionSelector, verifyingContract))` — KeyGate 条件の改ざん検知用（`RightsManifest.keyGate.conditionsHash`） |
| `purchaseRequestHash` | `keccak256(abi.encode(httpMethod, canonicalPath, planId(bytes32), resourceHash, policyHash))`。`canonicalPath` = 小文字化・末尾スラッシュ除去・クエリ順ソート済みパス。**個々のアクセス（復号）呼び出しの内容は含めない**（憲章 V） |
| `receiptHash` | `RightsReceipt` struct（17 フィールド）の **EIP-712 `hashStruct`**。ドメイン `{name:"TrueCollective", version:"1", chainId:296, verifyingContract: RightsRegistry}`。オンチェーン認可の権威 |

`useIndex` は Gateway が管理する厳密増加整数（`bytes32`/`uint32`）で、ハッシュ入力には含めない（`docs/idea.md` §6.3）。

### R-6a: `settleAndIssue` が policy 内容を再検証していない（2026-09-05 マルチモデルレビュー対応・**Critical**、Codex #1 と Fable C-1 が独立に一致して発見）

**問題**：`settleAndIssue` の既存ロジック（`solidity-interfaces.md` step 2）は `RightsNFT.policyHash(p.tokenId) == p.policyHash` のみを検証する。しかし `p.price` / `p.maxUses` / `p.transferMode` / `p.creatorBps` / `p.ownerBps` / `p.expiresAt` は呼び出し側の自由入力であり、**`p.policyHash` が本当にこれらの値から算出されたものかは一切検証されない**。攻撃者は正規の `policyHash`（`RightsNFT.policyHash(tokenId)` で誰でも読める）をそのまま `p.policyHash` にコピーしつつ、`p.price=0`（または 1 tinybar）・`p.maxUses=無制限`・長大な `p.expiresAt` を自由に指定して `settleAndIssue` を直接呼び出せる。全 require を通過し、オンチェーン権威 `hasValidConsumption` はこれを正規の Receipt として扱う。

**Decision（修正）**：`ReceiptParams` に `durationSec`（`uint64`）を追加し、`settleAndIssue` の検証ステップに以下を追加する：
```
2. require(RightsNFT.policyHash(p.tokenId) == p.policyHash)                                   // 既存（PolicyHashMismatch）
2a. require(p.policyHash == keccak256(abi.encode(
      p.price, p.durationSec, p.maxUses, p.permittedAction, p.transferMode,
      p.creatorBps, p.ownerBps)))                                                              // 新規：PolicyContentMismatch
2b. require(p.expiresAt == p.issuedAt + p.durationSec)                                          // 新規：ExpiryMismatch
```
`policyHash` の定義（`price(uint256), duration(uint64), maxUses(uint32), permissions(uint8), transferMode(uint8), revenueSplit(creatorBps uint16, ownerBps uint16)`）はこの表の並びと一致させる（上表を正典としたまま、`durationSec` を `duration` の実フィールド名として明記）。新規 custom error `PolicyContentMismatch` / `ExpiryMismatch` を `solidity-interfaces.md` の error 一覧・`error-codes.md` に追加する。

**Rationale**：`policyHash` はもともと「ポリシー内容の改ざん検知」のために存在する（本 R-6 節）。しかしそれを検証する側（`settleAndIssue`）がポリシーの**内容そのもの**からハッシュを再導出して照合しない限り、`policyHash` の一致検証は「攻撃者が正規値をコピーするだけで無効化できる」形骸的なチェックになる。修正は require 数行の追加のみで、既存の `ReceiptParams` 構造・呼び出し順序を破壊しない。**両モデルとも「実装着手前に直すべき最優先事項」と結論しており、Phase 3（T041 `ReceiptLib.sol` / T045 `RightsRegistry.sol`）着手時に必ず反映する。**

**epoch の命名（M1）**：所有者世代カウンタの **実フィールド名は `accessEpoch[tokenId]`**（`RightsNFT`、`_update` で +1）。概念名は「Owner Epoch」。Receipt に埋め込む発行時スナップショットは `ownerEpochAtIssue`（EIP-712 #8）で、`INVALIDATE_ON_TRANSFER` の検証時に現在の `accessEpoch(tokenId)` と比較する。3 語は同一の世代カウンタを指す。`licenseEpoch` は別カウンタ（`bumpLicenseEpoch` でのみ +1）。

### Rationale

- 憲章 V：「この全フィールドの EIP-712 struct hash を `receiptHash` と呼び、オンチェーンでの権利認可の権威とする」。
- Cross-Resource / Cross-Policy / Chain ID Spoofing（§10.1）テストは、これらのハッシュ定義が確定していないと flaky になる。
- Solidity と TypeScript で二重実装 → CI で「同一入力 → 同一ハッシュ」を検証する golden test を置く（憲章 IV）。

### Alternatives considered

| 代替案 | 却下理由 |
|---|---|
| canonical JSON の keccak | 空白・キー順・数値表現の曖昧さでチェーンをまたぐと不一致になりやすい。EIP-712 の方がツール（wallet の署名 UI 含む）と相性が良い |
| `receiptHash` をオフチェーンだけで使い、オンチェーンは別 ID | 憲章 V が「struct hash をオンチェーン権威に」と要求。二重管理は矛盾の元 |

---

## 技術選定の根拠（Technical Context の依存関係）

### Smart Contract：Hardhat 3 + Solidity 0.8.34（evm: cancun）

- **Decision**：`hedra-sample/hardhat-erc-721-mint` と同一（Hardhat 3 の `plugins` API、`@nomicfoundation/hardhat-toolbox-mocha-ethers`、`configVariable`、Solidity 0.8.34）。`hardhat.config.ts` の `solidity.settings.evmVersion = "cancun"`（Hedera mainnet 0.50.0 以降 = Cancun 相当、blob/Type-3 のみ不可）。OpenZeppelin Contracts 5.x。
- **Rationale**：Hedera 上で動く既知構成をコピーできる。EVM version を誤ると deploy 時に不可解なエラーになるため、`hedra-sample` の 0.8.34 に合わせるのが最も安全。
- **Alternatives**：Foundry のみ（`forge` 導入済み）→ Hedera 向けの deploy / verify プラグイン成熟度が Hardhat より不透明。**Foundry は攻撃マトリクスの fuzz テスト用に併存**させるのは可（`test/fuzz/`）。

### Backend（R-7）：Hono + Cloudflare Workers + Durable Objects + Hyperdrive/Postgres + viem

- **Decision**：HTTP は **Hono 4** + **`x402-hono`**、デプロイは **Cloudflare Workers**（`wrangler`）。並行制御の中核は **Durable Objects**（`ReceiptLock`、R-3）。永続化は **Hyperdrive 経由の PostgreSQL**（`postgres` ドライバ + `drizzle-orm`、`SELECT ... FOR UPDATE` / `UNIQUE` 可）＋ **Workers KV**（`share_G` 暗号化保管）＋ **Workers Secrets Store**（`share_U` / 署名鍵 / KEK）。チェーン読み取りは `viem`（Hedera relay を `http()` transport）。暗号は `@noble/*`（Workers runtime で動作、Node 依存なし）。
- **Rationale**：
  - **Durable Objects が「exactly-1 consume」に最適**（R-3）。`receiptHash` を鍵にした自然なシャーディングで、`SELECT ... FOR UPDATE` を跨ぐ競合すら構造的に排除できる。
  - `x402-hono` は公式パッケージ群に含まれ、Hono は Workers ネイティブ（cold start ほぼゼロ、エッジ配信）。SC-001/002 のレイテンシ予算に効く。
  - 憲章 V の RDB 制約要件は **Hyperdrive 経由の通常 Postgres** で維持できる（`postgres`/`pg` 互換ドライバがそのまま動く）。
  - `wrangler` によるデプロイが速く、`web`（Cloudflare Pages）と運用が一貫。`@cloudflare/vitest-pool-workers` で DO / KV を含めて Vitest でテストできる。
  - `@noble/hashes` / `@noble/curves` / `viem` はいずれも Workers runtime 対応（WebCrypto ベース）。
- **Alternatives**：
  - Express 4 + `x402-express` + Node コンテナ（当初案）→ 並行制御が単一プロセス前提で脆い。運用面でも `web` と分離。DO の直列化 primitive が使えない。
  - Hono を Node（`@hono/node-server`）で動かす → ローカル開発では使う。本番は Workers（DO / KV / Hyperdrive のため）。
  - Cloudflare D1（SQLite）を Postgres の代わりに → `SELECT ... FOR UPDATE` 相当の悲観ロックが弱い。既存の Postgres スキーマ知見を活かせない。KV/DO で足りない監査・集計クエリのために Postgres を残す。
  - ethers v6 → viem の方が Workers との相性・型・tree-shaking で優位（`hedra-sample` は ethers も使用、どちらでも可）。

### モノレポ・コード品質ツール（R-8）

- **Decision**：**pnpm workspace + Turborepo**（globs = `apps/*` + `packages/*`。デプロイ可能な成果物と AWS インフラ（`apps/cdk`）は `apps/`、共有は `packages/shared`〔ドメイン型〕と `packages/openapi`〔HTTP API 契約〕）。lint/format は **Biome**（`biome.json` ルート 1 枚、ESLint/Prettier 不使用）。デッドコード・未使用依存は **knip**（`knip.json`、CI で fail）。コード重複は **jscpd**（`.jscpd.json`）。型チェックは `tsc --noEmit`（各 workspace）。**API 契約は `packages/openapi/openapi.yaml`（OpenAPI 3.1）を単一定義とし `openapi-typescript` で型生成、`@redocly/cli` で lint**（FR-029）。テストは **Vitest**（`vitest.workspace.ts`、非コントラクト層）＋ **Playwright**（`apps/e2e` のブラウザ E2E）＋ **Newman**（`apps/e2e/postman/` の Gateway API E2E、レスポンスの OpenAPI スキーマ適合を assert）。CI は `packages/openapi#generate` → `turbo run lint test typecheck` + `knip` + `jscpd` + `redocly lint` + `newman run`。`apps/cdk` は typecheck / lint のみ CI 対象（`cdk deploy` は手動）。
- **Rationale**：
  - Biome は monorepo 全体を 1 設定・1 実行で高速に lint+format でき、`.claude/rules/code-style.md`（const-first、`type` vs `interface`、`satisfies` 優先、early return、boolean 命名）の多くを lint ルールで機械的に担保できる。
  - knip は「`packages/shared` に集約したはずが各所にコピーが残っている」「使わなくなった依存が残っている」をハッカソンの終盤で一掃するのに効く。
  - jscpd は `receiptHash` / ハッシュ計算 / EIP-712 型のような **絶対に重複させてはいけないロジック**（憲章 V の一致要件）が複製されていないかを検出する。
  - Turborepo でタスクグラフ（`apps/contracts#compile` / `packages/openapi#generate` → `packages/shared#build（ABI 同期）` → `apps/gateway|web|agent#build`）を宣言し、CI と `pnpm dev` の双方で使う。
- **Alternatives**：ESLint + Prettier + typescript-eslint → 設定が重く monorepo で遅い。Biome で十分。Nx → Turborepo より学習コストが高くハッカソン向きでない。`ts-prune` → knip の方が未使用依存も見る。

### Cloudflare スタックの `.claude` スキル

環境に `workers-best-practices` / `wrangler` / `cloudflare` / `durable-objects` / `agents-sdk` スキルがある。Workers / DO の実装時にこれらを参照する（`/speckit-tasks` で該当タスクに注記）。

### Frontend：React + Vite + Tailwind CSS + Privy

- **Decision**：Vite 5 + React 18 + TypeScript（`hedra-sample/x402-sample/apps/frontend` と同系）＋ **Tailwind CSS 4**（`@tailwindcss/vite` プラグイン、`@import "tailwindcss"` を `index.css` に、`tailwind.config.ts` はデザイントークンのみの最小構成）。ウォレットは `@privy-io/react-auth`（内蔵 EOA、スポンサー、KeyGate の決定的署名前提に必須）。Rights Graph クエリは `graphql-request`。復号は Web Crypto API（`crypto.subtle.decrypt` / `deriveBits` HKDF）。x402 は `x402-fetch`。
- **Rationale**：Privy×Hedera は `hedra-sample/x402-sample/apps/frontend/src/x402/privyHederaSigner.ts` で検証済み（`docs/idea.md` v1.4）。Tailwind 4 の Vite プラグインは PostCSS 設定不要で導入が最速、ハッカソンの UI（特にデモの 2 分割画面・EpochTimeline）を短時間で整える。Web Crypto はブラウザネイティブで追加依存ゼロ。Cloudflare Pages に静的デプロイして gateway（Workers）と運用を一貫。
- **Alternatives**：RainbowKit / wagmi コネクタ → Privy 賞（`docs/idea.md` §16.1）を狙うため Privy を中核に。CSS Modules / vanilla-extract → Tailwind の方が速い。Next.js → SSR 不要、Vite の方が軽快。

### R-9: MCP 決済ウォレット ＝ Privy server wallet（session signer + spend policy）

- **Decision**：MCP の `buy_access` / `decrypt_content` が使う決済ウォレットを、**Privy Server SDK の server wallet + session signer** で管理する。生の秘密鍵を Gateway / MCP サーバーが保持しない。**spend policy** を適用：(1) 1 セッションあたりの支出上限（テストネット HBAR 建て）、(2) 呼び出し可能なコントラクト・メソッドの allowlist（`RightsRegistry` の決済関数のみ ― ネイティブ HBAR 決済のためトークン `approve` は不要）、(3) レート制限。`apps/gateway/src/mcp/wallet.ts`（T092）。
- **Rationale**：
  - 憲章 VI（v1.2.0）「MCP 決済ウォレットは生鍵非保持＋ポリシー制約（MUST）」／FR-028 に直接対応。公開エンドポイントへ到達できるクライアントでもポリシー上限を超えて支出できない（`/speckit-analyze` I11：資金枯渇リスク＋「仲介者を信頼しない」プロダクト主張との整合）。
  - Privy を **単なるログインライブラリから load-bearing に格上げ**（I13）。session signer + policy は Privy「Best B2B Financial Product」($2,500) の "at least one Privy control（policies / signers / key quorums / intents）" 要件を満たす → Privy 2 トラックが射程に。
- **⚠ day1 検証**：Privy server wallet の session signer を **Cloudflare Workers ランタイムから**呼べるか（`@privy-io/server-auth` の fetch ベース API が `workerd` で動くか）、policy の method allowlist が Hedera（EVM）コントラクト呼び出しに効くか。
- **⚠ day1 検証の拡張（2026-09-05 マルチモデルレビュー対応・Fable H-9、Codex #15 と同種）**：Privy の spend policy（method allowlist / 支出上限）は Privy が **署名要求の中身を EVM トランザクションとして構造的に解釈できる場合**（`eth_sendTransaction` / `eth_signTransaction` 形式）にのみ適用される（Privy 公開仕様に基づく理解）。x402 決済で実際に Privy へ渡す署名要求が、Hedera 独自の署名形式（raw hash 署名等）になる場合、Privy はその中身（宛先・金額・メソッド）を解釈できず policy が素通りになる可能性がある。day1 probe（T020/T068 と併せて実施）で以下を確認する：
  1. x402 決済で Privy に送る署名要求が「typed transaction」か「raw hash 署名」かを特定する。
  2. **陽性対照**：支出上限を意図的に超える金額でリクエストし、Privy policy が実際に**拒否**することを観測する（拒否を観測できて初めて policy が効いていると言える。設定しただけでは未検証）。
  3. raw hash 署名にしかならないと判明した場合、README で「Privy policy は決済 tx の value/宛先を解釈できないため、アプリ層の hard cap（残高上限 + per-call 上限チェック）で代替」と格下げ開示し、Privy「Best B2B Financial Product」の主張は「Privy signer による生鍵非保持」に絞る（`plan.md` Complexity Tracking に条件付きで追記）。
- **Alternatives**：
  - 資金付き EOA の生鍵を Workers Secrets Store に保持（旧案）→ 公開エンドポイントが実質「誰でも使える送金 API」。憲章 VI 違反、I11 の指摘どおり。
  - アプリ層のレート制限のみ → hard な支出上限にならない。ノード侵害・バグで残高全損リスク。
  - Coinbase CDP / 他の server wallet → Privy を既に web で使うため統合面が一貫し、賞要件（Privy control）にも直結。

### AI Agent 実行基盤：MCP Server（v1.6、`docs/idea.md` v1.6 追記で確定）

- **Decision**：自前 Node CLI（旧案）ではなく **MCP（Model Context Protocol）サーバー**として実装する。`discover_assets`（subgraph GraphQL のラップ）・`buy_access`（`x402-fetch` 相当の処理 + **Privy server wallet（R-9）** での署名・submit）・`decrypt_content`（`packages/shared` の KeyGate 導出・復号を代行し、復号済みデータセットをツールの戻り値として返す）の3ツールを公開する。ホスティングは既存 Gateway（Hono on Cloudflare Workers）に相乗りし、Streamable HTTP/SSE トランスポートでリモート公開する。デモでは Claude Code / Codex 等の MCP 対応クライアントから直接接続し、それらのAIが自律的にツールを呼び出す。`analyze`（データセットへの分析質問への回答）はツールとして公開せず、接続先AI自身の推論に委ねる。
- **Rationale**：憲章 III「AI Agent による復号後データセットへの分析推論」を、実世界の汎用AIツール（Claude Code / Codex）との相互運用性というかたちで実証する。自前スクリプトより説得力のある「本物のAIエージェントが実際に接続して取引する」デモになる（`docs/idea.md` §12.1・§13）。
- **人手0の自動検証（SC-007／SC-009）**：ライブデモは人が Claude Code / Codex を起動して1回指示を出すのみで、以降は自律実行（人手0の定義は元の Node CLI 案と同じ）。加えて CI では、`apps/agent/test/` 配下に「MCP クライアント役として同じ3ツールを呼び、Claude tool-use で分析まで行う」自動テストハーネスを維持し、discover → purchase → decrypt → analyze の一連を人手なしで検証する（T120–T121、実推論・モックなし）。
- **鍵管理**：x402決済ウォレットは **Privy server wallet（session signer + spend policy、R-9）** で管理し、生鍵を MCP サーバー / Gateway が保持しない。リモート公開エンドポイントだが、policy の支出上限・method allowlist・レート制限により、URL へ到達できるクライアントでも上限を超える支出はできない（FR-028 / SC-011、`docs/idea.md` §9.1 信頼モデル）。デモ用に最小残高のみ保持。
- **Alternatives**：旧案（自前 Node CLI + `@anthropic-ai/sdk` tool-use を内部で完結）→ 人手0の自動化は満たすが、「実際の汎用AIクライアントとの相互運用性」を示せず、審査員が自分の環境から操作できない。OpenAI → MCP はクライアント非依存なのでどちらでも可。ローカル小型モデル → デモの信頼性と回答品質で不利。LangGraph 等のフレームワーク → MCP サーバー側にオーケストレーションを持たせる必要がないため不要。

### R-9a: MCP `decrypt_content` が無認証・購入者非束縛のため、第三者が他人の購入済みコンテンツを読める（2026-09-05 マルチモデルレビュー対応・**Critical 相当**、**Fable H-1 が発見・Codex は未指摘**）

**問題**：`buy_access` で発行される `receiptHash` は `ReceiptIssued` イベント経由で subgraph / HashScan に公開される。MCP の3ツールは無認証（`mcp-tools.md` §信頼モデル注記）かつ `decrypt_content` は入力 `{assetId, receiptHash}` のみで平文を返すため、**`receiptHash` を知っている任意のMCPクライアントが、他人が購入したReceiptを使って`decrypt_content`を呼べる**。「権利は購入者に束縛される」という製品の中心的主張が、そのままではデモ環境で反証されうる（審査員Aが購入した直後に、第三者Bがsubgraphから`receiptHash`を拾い`decrypt_content`を呼べばBに平文が渡り、かつAの`maxUses`を消費してしまう）。

**Decision（修正）**：MCP の Streamable HTTP セッション（`Mcp-Session-Id`）を「購入主体」の識別子として扱う。
- `buy_access` 成功時、`receiptHash → mcpSessionId` を Gateway 側（新設テーブル `mcp_session_binding`、`data-model.md` 参照）に記録する。
- `decrypt_content` は、渡された `receiptHash` が**呼び出し元と同一の `Mcp-Session-Id` で購入されたものであること**を確認してから処理を続行する（不一致は新規エラー `MCP_SESSION_MISMATCH` で拒否）。
- Privy spend policy の「1 セッションあたりの支出上限」（R-9）の「セッション」も、この `Mcp-Session-Id` に統一して定義する（曖昧さの解消）。

**Rationale**：これにより、無認証の MCP エンドポイント自体は変えず（デモの簡便性を維持）、「購入した本人だけが復号できる」という中心的主張をデモ環境でも成立させられる。修正範囲は `apps/gateway/src/mcp/tools/buyAccess.ts` / `decryptContent.ts` とテーブル1つの追加に限られ、既存の3ツールのインターフェース（Input/Output）は変えない。

**Alternatives considered**：MCP 自体に API キー認証を導入 → 本番運用では望ましいが MVP のデモ簡便性を損なう（非ゴール）。`receiptHash` を非公開にする → subgraph でのオンチェーン監査という中心的な訴求（FR-020）と矛盾するため不採用。

### Subgraph：graph-cli（Hedera Testnet）

R-5 参照。

---

## R-10: `payment_binding` の一意性制約不備（2026-09-05 マルチモデルレビュー対応・High、Codex #5 と Fable H-2 が独立に一致）

### Decision

現行の `UNIQUE(payment_id, purchase_request_hash)`（複合キー）は「同一 `payment_id` で異なる `purchase_request_hash`」の共存を許してしまい、憲章 V が意図する「同一 `payment_id` の再利用防止」を満たさない。以下に修正する：

- `payment_binding.payment_id` を**単独 PK**にする。
- INSERT 時に衝突したら、既存行の `purchase_request_hash` と新規リクエストのそれを比較する：一致すれば**冪等応答**（既存の `receiptHash` を返す。未 settle なら settle を再試行）、不一致なら `PAYMENT_ID_PAYLOAD_CONFLICT`。
- `status`（`pending` / `settled` / `failed`）列を追加し、facilitator タイムアウト後の正当なリトライを可能にする（`failed` は再試行可）。
- `payment_id` は client の自由入力にせず、facilitator の settle 応答（tx id）または buyer 署名ペイロードの keccak から **決定的に導出**する（client が他人の `payment_id` を先取り INSERT する griefing を防ぐ）。

### Rationale

複合 UNIQUE は「衝突検知」であって「単一性の保証」ではない。単独 PK + 内容比較 + 状態遷移にすることで、憲章 V の「一回限りの支払い証明」を字義どおり満たしつつ、正当なリトライ（facilitator 側の一時的失敗）を殺さない。

---

## R-11: 所有者パスの Cross-Resource 攻撃（`assetId`/`tokenId` 対応未検証、2026-09-05 マルチモデルレビュー対応・High、Fable H-10 が発見・Codex は licensee 側の Cross-Resource のみ言及）

### Decision

`gateway-api.md` の `POST /owner/keygate` は `tokenId` と `assetId` を別々に request で受け取り、`ownerOf(tokenId)` の検証と `share_G[assetId]` の取得先が独立している。所有者が自分の `tokenId` の所有権を提示しつつ `assetId` に**他人の資産**を指定すると、その他人の資産の `share_G` が返る（`assetId` と `tokenId` の対応をサーバ側が検証していないため）。

**修正**：`assetId` から Rights Manifest を引いて `manifest.tokenId` / `manifest.nftContract` を導出し、**クライアントから送られた `tokenId` は使わない**（または一致することを require）。`OwnerAuthChallenge` に `assetId` を追加し署名に束縛する（`eip712-types.md`）。`error-codes.md` §10.1 の Cross-Resource テストに owner パスのケースを追加する。

### Rationale

Cross-Resource 攻撃は licensee パス（`resourceHash` 照合）では既にテスト対象（§10.1 #3）だが、owner パスは `assetId`/`tokenId` の対応検証が抜けていたため同じ攻撃クラスに脆弱だった。修正はサーバ側のルックアップ順序を変えるだけで、クライアント API の形は変わらない。

---

## 未解決だが Phase 1 をブロックしないもの（day1 タスクへ）

- R-2 / R-4 / R-5 / R-9 の「⚠ day1 検証」項目：`hedra-sample` の再現と Hedera Testnet への最小デプロイで確定。Phase 1 の contracts / API 設計は **primary を前提に**進め、フォールバックも contracts 側に口を用意しておく（`RightsRegistry.finalize` / `refundUnfinalized` を optional path として定義）。
- **R-9（day1、T092 の前提）**：Privy server wallet の session signer が `workerd` から呼べるか、spend policy（method allowlist / セッション上限）が Hedera コントラクト呼び出しに効くかを最小構成で確認。不可なら暫定でアプリ層の hard 上限（ウォレット残高キャップ + リクエストごとの上限額チェック）にフォールバックし README 開示。**加えて R-9a：spend policy が実際に拒否を発火することを陽性対照で確認する（policy を「設定した」だけで「効いている」と扱わない）**。
- x402 facilitator を Blocky402 にするか自前にするか：day1 に Blocky402 facilitator の Hedera Testnet エンドポイントの死活と ContractCall 対応を確認して決定。**R-2a により、T020 の probe は primary（`settleAndIssue{value}`）と fallback（`payFor{value}`）の両方の ContractCall 対応を同時に確認する。**
- **R-7 の Workers 疎通（day1）**：`viem` / `@noble/hashes` / `@noble/curves` / Postgres ドライバ（`postgres`）が `workerd` で動くこと、Hyperdrive 経由で `SELECT ... FOR UPDATE` が使えること、`@cloudflare/vitest-pool-workers` で `ReceiptLock` DO をテストできることを最小 Worker で確認。`x402-hono` の Hedera「exact」対応も確認。
- **R-8 の CI ゲート（day1）**：`turbo` タスクグラフ（`apps/contracts#compile` / `packages/openapi#generate` → `packages/shared#build` → `apps/gateway|web|agent#build`）と、`biome ci` / `knip` / `jscpd` / golden test（EIP-712 一致）/ `redocly lint openapi.yaml` / `newman run`（デプロイ済み gateway に対する API 契約テスト）を GitHub Actions に載せる。`.claude/rules/development.md` の「サブエージェント逐次」「大規模出力を親に取り込まない」に沿って重い処理は scripts に切り出す。
- **R-4（day1、T018 の拡張）**：`msg.value / 1e10` の tinybar 変換と、tinybar 単位での `mulDiv` 分配が dust ゼロで成立することを実 Testnet で確認（旧・weibar 単位のまま分配する設計は Fable H-7 により撤回）。
- **R-6a（Phase 3 着手時に必須）**：`settleAndIssue` の policy 内容再ハッシュ検証（`PolicyContentMismatch` / `ExpiryMismatch`）を T041 / T045 の実装に含める。これを含めないまま Phase 3 を green にしない。
- **R-9a（Phase 7 着手時に必須）**：`decrypt_content` の MCP セッション束縛（`mcp_session_binding`）を T092/T095 の実装に含める。

## day1 probe 結果の記録欄（マルチモデルレビュー対応・2026-09-05 追加）

T018–T021 に加え、本レビューで拡張が必要になった検証項目を以下に追記する。結果はここに追記すること。

| 項目 | 検証内容 | 結果（未実施） |
|---|---|---|
| R-2a | `payFor{value}` 相当の ContractCall も Blocky402 で成立するか（primary/fallback 同時確認） | TBD |
| R-4（拡張） | `msg.value / 1e10` の tinybar 変換・tinybar 単位 `mulDiv` の dust がゼロになること | TBD |
| R-9a | Privy spend policy が実際に拒否を発火する陽性対照（上限超過リクエストで reject） | TBD |
| R-9a | x402 決済で Privy に渡す署名要求が typed tx か raw hash か | TBD |
