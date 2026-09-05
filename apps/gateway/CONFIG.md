# Gateway configuration: bindings and `wrangler secret put` targets

Values below are **never** placed in `wrangler.toml` or committed. For local `wrangler dev` use
`.dev.vars` (copy `.dev.vars.example`). The Worker must already be deployed once before
`wrangler secret put` works (see tasks.md T076 / T097 ordering).

| Name | Purpose | Set by |
|---|---|---|
| `HEDERA_OPERATOR_KEY` | Operator EOA private key used for `RightsRegistry.consume` / `bumpLicenseEpoch` tx submission (via `OperatorTxQueue` DO). | `wrangler secret put HEDERA_OPERATOR_KEY` |
| `RECEIPT_SIGNER_KEY` | Key that server-signs EIP-712 Rights Receipts after settlement (convenience credential, not the authorization authority). | `wrangler secret put RECEIPT_SIGNER_KEY` |
| `KV_KEK` | 32-byte hex key encrypting `share_G` blobs in the `SHARE_G` KV namespace (`packages/shared/src/kv-format.ts`). | `wrangler secret put KV_KEK` |
| `SHARE_U_<assetIdHex>` | Per-asset `share_U` for the owner path (residual trust point, disclosed in README). Loaded by `scripts/load-shares.ts` from `apps/contracts/out/seed-artifacts.json`. | `scripts/load-shares.ts` |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Privy server wallet (session signer + spend policy) used by the MCP `buy_access` tool. The raw payment key is never held here. | `wrangler secret put ...` |

`ANTHROPIC_API_KEY` is not needed by the gateway; only `apps/agent` (CI harness) uses it.

Bindings that are ids rather than secrets (`SHARE_G` KV namespace id, `HYPERDRIVE` id) are
filled into `wrangler.toml` after `wrangler kv namespace create SHARE_G` and
`wrangler hyperdrive create truecollective --connection-string=<postgres url>`.
