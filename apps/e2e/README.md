# apps/e2e

End-to-end verification of the deployed system: Playwright browser flows, script-level
attack / indexer scenarios and the Postman + Newman API contract suite. Everything here
talks to a real gateway on Hedera Testnet; nothing is mocked (constitution principle III).

## What runs where

| Command | What | Needs |
|---|---|---|
| `pnpm test:unit` | Vitest over the tooling itself: `metrics.ts` maths and the Postman-vs-OpenAPI coverage check (`collection.test.ts`) | nothing |
| `pnpm test` | Playwright specs `*.e2e.ts` (skipped, with a printed notice, unless `WEB_URL` + `GATEWAY_URL` are set; `E2E_REQUIRED=1` turns the skip into a failure) | see below |
| `pnpm test:api` | Newman over `postman/gateway.postman_collection.json` (every item asserts the OpenAPI envelope / error code it expects) | `GATEWAY_URL` + `ASSET_ID` in the environment file |
| `pnpm metrics` | Prints the latency report from `test-results/metrics.jsonl` and exits non-zero when a threshold in `metrics.ts` is missed or has no sample (BLOCKED, never PASS) | a previous Playwright run |

## Specs

| File | tasks.md | Scenario |
|---|---|---|
| `ownerFlow.e2e.ts` | T100 | SC-001 / SC-008: Privy login → Market → owner unlock in ≤ 3 clicks, `owner_access_ms` |
| `transfer.e2e.ts` | T101 | SC-003 / FR-015: transfer → old owner refused within 10 s, ciphertext CID unchanged |
| `buyerFlow.e2e.ts` | T102 | SC-002: x402 purchase (native HBAR) → decrypt, second use within `maxUses`, `buyer_access_ms` |
| `splitScreen.e2e.ts` | T103 | US3-3: previous owner refused while a SURVIVE licensee keeps decrypting, at the same time |
| `attacks.e2e.ts` | T116 | Concurrent Replay (20 real parallel calls, `replay_reject_ms`), Chain-ID spoofing, Cross-Resource |
| `onchain-indexer.e2e.ts` | T058 | script-level transfer / settle / consume and the Graph Node view of each event |
| `demo-3min.e2e.ts` | T118 | the quickstart §2 3-minute demo script end to end, one timestamp per step |

`lib/gateway.ts` drives the gateway from Node with the seeded accounts (`wallets.ts`, written by
`apps/contracts/scripts/seed.ts`): owner / licensee challenges, `@x402/hedera` purchases,
concurrent replay. `lib/chain.ts` reads epochs and transfers the NFT directly on Hedera.
`lib/ui.ts` holds the Privy login and the assertions shared by the browser specs.

## Environment

| Variable | Used by |
|---|---|
| `WEB_URL`, `GATEWAY_URL` | every spec (absent → skipped) |
| `RIGHTS_NFT_ADDRESS`, `RIGHTS_REGISTRY_ADDRESS`, `HEDERA_RPC_URL`, `HEDERA_CHAIN_ID` (296), `HEDERA_MIRROR_URL` | node-side signing and chain reads |
| `SUBGRAPH_URL` | `onchain-indexer.e2e.ts` (absent → that spec is skipped) |
| `E2E_PRIVY_EMAIL`, `E2E_PRIVY_OTP` | browser specs: a Privy **test account** (dashboard → Test accounts, fixed OTP). Absent → browser specs skip as BLOCKED. The embedded wallet must hold Testnet HBAR for `buyerFlow` |
| `TEST_ACCOUNTS_PATH` | overrides `.accounts.json` (owner-A / owner-B / buyer keys from the seed script) |

A skipped spec is reported as skipped, never as passed: the metrics report refuses to
declare a threshold met without samples.
