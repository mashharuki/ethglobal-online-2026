# apps/agent

CI verification harness for the "AI agent" leg (tasks.md T120 / T121, SC-007 / SC-009). It is
**not** the production agent: the demo connects a real MCP client (Claude Code, Codex, …) to the
gateway's `/mcp`. This package plays that client in CI so the zero-human-intervention claim can
be checked without launching an interactive AI product.

```
discover_assets ──► buy_access ──► decrypt_content ──► Claude (tool `answer`) ──► verify ──► out/answer.json
   (Rights Graph)   (x402, native HBAR,   (KeyGate consume,      real inference,      harness-side,
    discovery only   Privy server wallet)  Hedera Testnet tx)     untrusted dataset    model is not
                                                                   in its own block)    the judge
```

## Run

```bash
GATEWAY_URL=https://gateway.<host>.workers.dev ANTHROPIC_API_KEY=… \
  pnpm --filter agent start -- [--question "…"] [--asset 0x…] [--out path]
```

One process, no prompt, no confirmation: the run either reaches a **verified** answer or exits
non-zero. Inference configuration (the API key) is checked before any HBAR is spent; only
`--flag value` pairs of the three known flags are accepted (a malformed `--asset`, an
`--asset=…` form, an unknown flag or a duplicate is an error rather than a silent fallback to
the first listing); and `out/answer.json`
is written only after verification passed. It records the MCP session, the receipt hash and both
Hedera transactions (settle and consume), the dataset size, the model, the structured answer with
its evidence, the verification verdict and the timestamps of each leg.

### How the answer is verified (without trusting the model)

1. The model must answer through one forced tool (`answer`) with `evidence` citations; an empty
   or malformed citation is an error, not something to drop.
2. Every cited value must appear verbatim in the decrypted dataset.
3. With `AGENT_CHECK` (default `{"labelColumn":"district","valueColumn":"visitors","op":"max"}`,
   the shape of the seeded demo dataset A) the harness tabulates the dataset itself (JSON
   `{columns, rows}` or RFC 4180 CSV; ragged, non-numeric or unlabeled rows are errors),
   computes the winning row with exact decimal comparison, and requires the model's structured
   `result` to equal it exactly, every citation to be a real (label, value) row of the table
   with the winning row among them, and the free text to open with `<label>: <value>` as a whole
   token and contain no negation. The verified artifact is the harness-generated `statement`
   (`verifiedAnswer` in the record and CLI output); the model's free text is kept as
   `modelText` for the record only. The question is derived from the check unless `--question`
   overrides it. A check whose columns are absent from the dataset fails the run (no silent skip).

The decrypted dataset is treated as untrusted input: it is sent in its own `<dataset>` block,
separated from the instructions, with a system prompt that says its content is never an
instruction. That limits prompt injection; step 3 is what makes an injected answer fail anyway.

| Variable | Meaning |
|---|---|
| `GATEWAY_URL` | deployed Access Gateway; the MCP endpoint is `${GATEWAY_URL}/mcp` |
| `ANTHROPIC_API_KEY` | Claude API key for the analysis (real inference, never cached) |
| `ANTHROPIC_MODEL` | optional, default `claude-sonnet-5` |
| `AGENT_CHECK` | optional JSON `{labelColumn, valueColumn, op: max|min}` for the deterministic check |
| `HEDERA_MIRROR_URL` | optional, mirror node used by the CI spec to confirm both transactions succeeded |

## Tests

- `pnpm --filter agent test` runs the unit tests (argument parsing, asset choice, MCP result
  decoding and field validation against the real MCP SDK server transport in-process, the
  session-id requirement, `answer` tool decoding, the untrusted-dataset prompt layout and the
  verification gate) and `test/autonomous.spec.ts`, which is **skipped with a printed notice**
  unless `GATEWAY_URL` and `ANTHROPIC_API_KEY` are set. When they are, it performs the live run
  above and asserts: one MCP session, a bytes32 receipt, settle and consume transactions that
  the Hedera mirror node reports as `SUCCESS`, a non-empty dataset, a verified answer naming the
  expected row, the legs in order, the written `out/answer.json`, and - as a negative control -
  that a second MCP session is refused with `MCP_SESSION_MISMATCH` when it presents the same
  receipt. A second live case shows the run fails closed when the check cannot be satisfied.
- The payment wallet is the gateway's Privy server wallet (spend cap `MCP_SESSION_SPEND_CAP_TINYBAR`
  on the gateway side); this package holds no key of its own.

## Connect a real MCP client

The same three tools are what a live AI client uses. Claude Code, for example, registers the
remote server with the `claude mcp add --transport http rights-runtime <GATEWAY_URL>/mcp`
command, after which the assistant can discover, buy and decrypt on its own.
