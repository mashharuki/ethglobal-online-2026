# Gateway configuration: bindings, secrets and operational scripts

Values below are **never** placed in `wrangler.toml` or committed. For local `wrangler dev` use
`.dev.vars` (copy `.dev.vars.example`). The Worker must already be deployed once before
`wrangler secret put` works (see tasks.md T076 / T097 ordering).

| Name | Purpose | Set by |
|---|---|---|
| `HEDERA_OPERATOR_KEY` | Operator EOA private key used for `RightsRegistry.consume` / `bumpLicenseEpoch` tx submission (via `OperatorTxQueue` DO). | `wrangler secret put HEDERA_OPERATOR_KEY` |
| `RECEIPT_SIGNER_KEY` | Key that server-signs EIP-712 Rights Receipts after settlement (convenience credential, not the authorization authority). | `wrangler secret put RECEIPT_SIGNER_KEY` |
| `KV_KEK` | 32-byte hex key encrypting `share_G` blobs in the `SHARE_G` KV namespace (`packages/shared/src/kv-format.ts`). | `wrangler secret put KV_KEK` |
| `SHARE_U_<assetId hex, no 0x>` | Per-asset `share_U` for the owner path (residual trust point, disclosed in README). Loaded by `scripts/load-shares.ts` from `apps/contracts/out/<chainId>/seed-artifacts.json`. | `scripts/load-shares.ts` |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Privy server wallet (session signer + spend policy) used by the MCP `buy_access` tool. The raw payment key is never held here. | `wrangler secret put ...` |

`ANTHROPIC_API_KEY` is not needed by the gateway; only `apps/agent` (CI harness) uses it.

Accessors live in `src/keygate/vault.ts` (tasks.md calls it `keygate/secrets.ts`; the file is
named `vault.ts` because repo tooling refuses paths containing "secret"). They validate shape,
return fresh byte copies and never memoise.

## Non-secret vars (`wrangler.toml [vars]`)

`HEDERA_CHAIN_ID`, `HEDERA_RPC_URL`, `X402_FACILITATOR_URL`, `PAYMENT_ASSET`, `SETTLEMENT_MODE`,
`SUBGRAPH_URL`, `RIGHTS_NFT_ADDRESS`, `RIGHTS_REGISTRY_ADDRESS`, `IPFS_GATEWAY_URL`. Empty contract
addresses fall back to `packages/shared` `DEFAULT_DEPLOYMENT` (written by `apps/contracts` deploy,
T047). `SUBGRAPH_URL` is only a discovery hint for the assetId -> tokenId lookup
(`src/graph/lookup.ts`); the mapping is proven on chain before anything is released (R-11).

## Settlement rail (tasks.md T084 / T088, research.md R-2a)

`SETTLEMENT_MODE` selects how an x402 payment becomes a Rights Receipt:

| mode | who pays what | anchor | notes |
|---|---|---|---|
| `primary` | Blocky402 settles a value-attached `settleAndIssue` ContractCall | same tx | depends on the day1 probe T020; the `@x402/hedera` exact scheme only carries plain HBAR transfers, so this is NOT expected to work |
| `custodial` (default) | buyer's x402 HBAR transfer to `SETTLEMENT_ACCOUNT_ID`, settled by Blocky402 | operator submits `settleAndIssue{value}` through OperatorTxQueue | non-atomic and the gateway account holds the HBAR briefly - both disclosed in the README (constitution "やむを得ず" clause) |
| `fallback` | buyer calls `payFor{value}(paymentId, committedParamsHash)` on chain | `POST /assets/{assetId}/finalize` -> operator `finalize(paymentId, p)` | `/paid` answers SETTLEMENT_NOT_FINALIZED on this rail |

`payment_id = keccak256(X-PAYMENT bytes)` (R-10). The licensee must be the payer of the signed
payload: the facilitator's `payer` account is resolved through `HEDERA_MIRROR_URL` and compared
with the `licensee` in the body (LICENSEE_MISMATCH otherwise, also when no payer is reported).
The 402 `receiptQuote` (including the server-chosen receipt `nonce`) travels back inside
`payload.accepted.extra`; the receipt is a pure function of quote + licensee + paymentId, so a
replay of the same payload returns the identical receipt and hash, and it is re-validated
against fresh chain reads before the facilitator is called and again right before anchoring.

`payment_binding` separates three things: `status` (pending / settled / failed), the durable
payment evidence (`paid_at`) and claim ownership (`claim_token` + `claimed_at`, 60 s lease).
Every lifecycle write is a CAS on the caller's token, so a request that lost its claim cannot
downgrade a row another request completed. `stage` is written BEFORE the step it describes,
so a crash is read the same way as a thrown error:

| stage reached | failure -> row | what a retry of the same payload does |
|---|---|---|
| verify (facilitator `/verify`, payer check) | `failed`, claim released | runs the whole settlement again (nothing moved) |
| settle (`/settle` in flight) | stays `pending` / `settle`, claim released | SETTLEMENT_IN_PROGRESS - outcome unknown, reconcile against the facilitator / mirror node before touching the row |
| rejected (`/settle` answered `success === false`) | `failed` | runs the whole settlement again |
| anchor (`paid_at` set; quote re-check, operator `settleAndIssue`, log match) | stays `pending` / `anchor`, claim released, deny audit | resumes at anchoring under a new claim - the facilitator is never called again for this payload. A stale quote keeps failing here: the HBAR stays on `SETTLEMENT_ACCOUNT_ID` (no refund path, constitution non-goal) |
| settled (receipt on chain, `done`) | stays `settled` | replays the receipt + signature |

A live claim (lease not expired) makes concurrent retries wait briefly, then answer
SETTLEMENT_IN_PROGRESS; an expired lease is taken over according to the stage above.

Anchoring treats the registry as the authority: whatever the operator call or the receipt
wait threw, `RightsRegistry.receiptStatus(expectedHash).issued === true` means it succeeded
(`onchainTx: "already-issued"`). `/finalize` recovers an already-issued receipt the same way
before it demands current issuance terms.

## HTTP routes (tasks.md T086-T091)

`src/routes/*` only parse input (zod) and call the services bundle (`src/services.ts`): chain
reads via viem, Durable Objects, the facilitator client. Non-domain failures (malformed body
400, unknown asset 404, subgraph down 502, internal 500) answer `{ error, message? }`; every
domain rejection is the openapi `Error` body from `AppError`.

## KeyGate / auth modules (tasks.md T077-T083)

| Module | Role |
|---|---|
| `src/auth/verify.ts` + `auth/nonce.ts` | nonce-bound EIP-712 authentication (`OwnerAuthChallenge` / `LicenseeAuthChallenge`, TTL 120 s, single use). A `KeyGateChallenge` signature is never accepted as authentication (R-1a). |
| `src/auth/session.ts` | HMAC-signed `ownerSession` / fallback grants (error-code selection only, never authorization). MAC key = HKDF(`RECEIPT_SIGNER_KEY`, purpose). |
| `src/keygate/split.ts` | `blindedU = share_U XOR HKDF(keyGateSig)` computed once per (asset, wallet, path) and stored in `wallet_blinded_shares`. Arithmetic lives in `packages/shared/src/keygate.ts` (shared with web / agent). |
| `src/keygate/release.ts` | the single release decision (owner + licensee paths); chain reads injected via `keygate/ports.ts`. |
| `src/keygate/fallback.ts` | disclosed fallback: gateway reconstructs K and decrypts (constitution VI deviation, README). |
| `src/do/ReceiptLock.ts` / `do/OperatorTxQueue.ts` | R-3 / R-3a Durable Objects; decision logic in `receiptLockCore.ts` / `operatorQueueCore.ts`. |
| `src/middleware/rateLimit.ts` | 60 req/min per IP on `/assets/*`, 30 req/min per wallet on `/owner/*` and `/keygate/*`. |

Bindings that are ids rather than secrets (`SHARE_G` KV namespace id, `HYPERDRIVE` id) are
filled into `wrangler.toml` after `wrangler kv namespace create SHARE_G` and
`wrangler hyperdrive create truecollective --connection-string=<postgres url>`.

## Postgres schema (drizzle)

- `src/db/schema.ts` is the schema (data-model.md 2.3); `src/db/migrations/` holds the generated
  SQL and is committed.
- `pnpm --filter gateway db:generate` regenerates migrations after a schema change.
- `pnpm --filter gateway db:migrate` applies them to `DATABASE_URL` (the Hyperdrive origin).
  The Worker never runs DDL.
- `pnpm --filter gateway test:node` runs the schema tests against PGlite (no server needed).

## Scripts

| Script | What it does |
|---|---|
| `pnpm --filter gateway sync-abis` | Regenerates `src/chain/abi.ts` from `apps/contracts` artifacts (run after `contracts compile`). |
| `KV_KEK=<hex> pnpm --filter gateway load-shares -- [--chain-id 296] [--dry-run] [--local]` | Encrypts `share_G` per asset and puts it into KV; `share_U` goes to `SHARE_U_<assetId>` secrets via stdin. `--dry-run` writes only ciphertext to `out/<chainId>/`; `--local` targets the Miniflare KV and writes a 0600 `share-u.dev.vars` to append to `.dev.vars`. |
| `pnpm --filter gateway probe:workerd` | T019 probe: runs `test/probe.spec.ts` in workerd and writes `out/probe-workerd.json`. |
