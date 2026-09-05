# Specification Quality Checklist: Transfer-Coupled Rights Runtime MVP

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-02
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — **意図的な例外 4 点あり（§Notes、2026-09-04）**
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details) — **SC-010 / SC-012 は §Notes の例外に該当**
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification — **§Notes の 4 例外を除く**

## Notes

- 入力元は `docs/idea.md`（当初 v1.6。以後 v1.7 スポンサー戦略、v1.8 決済資産をネイティブ HBAR に変更）。技術・設計上のオープン項目はゼロの状態で本specを作成したため、`[NEEDS CLARIFICATION]` マーカーは発生しなかった。

- **「実装詳細なし」の意図的な例外（2026-09-04、`/speckit-analyze` M2 対応）**。以下の 4 点は、外部制約またはみのるんの明示要件により spec 本文へ入れることを判断した。いずれも「なぜその技術か」の根拠が spec 内に併記されている：
  1. **FR-029 / SC-010 / SC-012 の OpenAPI・Postman・Newman・`openapi-typescript`** ── API 契約ドリフトを機械的に防ぐという要件そのものがツール前提（みのるんの明示要件）。抽象化すると「フロント/バックの API 型を一致させる」だけになり検証手段が不定になる。
  2. **Assumptions の「決済資産＝ネイティブ HBAR / Blocky402 / weibar・tinybar 単位」** ── トラック必須の facilitator が対応しない資産を選べないという外部制約。理由（`/supported` 応答）を併記。憲章 v1.3.0 に同期済み。
  3. **Assumptions の「MCP サーバーは Access Gateway と同一 Cloudflare Workers 上」「Privy server wallet の session signer」** ── FR-028（生鍵非保持＋ポリシー制約）の具体化。憲章 VI に対応。
  4. **`packages/openapi/openapi.yaml` / `apps/e2e/postman/` のパス** ── モノレポ構成が確定済みのため、監査・レビュー時の参照先として明示。
  それ以外の技術方式（Hono / Hardhat / KeyGate の分割構成など）は従来どおり `plan.md` に隔離している。

- `docs/idea.md` にある固有の技術名称（Owner Epoch, Rights Receipt, KeyGate, RightsRegistry 等）は、プロダクトの発明そのものを指すドメイン用語であるため、spec本文では実装非依存な機能表現に言い換えた（例：「ゲートウェイ分散鍵方式」→「復号を仲介する側は単独では復号できない構成」）。詳細な実装方式は `/speckit-plan` で `docs/idea.md` §6–11 を直接参照して設計する。
- `docs/idea.md` にある固有の技術名称（Owner Epoch, Rights Receipt, KeyGate, RightsRegistry 等）は、プロダクトの発明そのものを指すドメイン用語であるため、spec本文では実装非依存な機能表現に言い換えた（例：「ゲートウェイ分散鍵方式」→「復号を仲介する側は単独では復号できない構成」）。詳細な実装方式は `/speckit-plan` で `docs/idea.md` §6–11 を直接参照して設計する。
- チェーン選定（Hedera）・スポンサー統合（submit = Hedera「AI & Agentic Payments」＋ Privy ×2。The Graph は自前ホストで賞対象外、v1.7）はプロダクト戦略上の決定であり、本specでは意図的に技術非依存な記述に留めた。`/speckit-plan` の Constitution Check 時に `docs/idea.md` §16 と整合させること。
