# apps/agent

CI verification harness for the "AI agent" leg (tasks.md T120 / T121, SC-007 / SC-009). It is
**not** the production agent: the demo connects a real MCP client (Claude Code, Codex, …) to the
gateway's `/mcp`. This package plays that client in CI so the zero-human-intervention claim can
be checked without launching an interactive AI product.

```
discover_assets ──► buy_access ──► decrypt_content ──► Claude (tool `answer`) ──► out/answer.json
   (Rights Graph)   (x402, native HBAR,   (KeyGate consume,      real inference,
    discovery only   Privy server wallet)  Hedera Testnet tx)     evidence verbatim
```

## Run

```bash
GATEWAY_URL=https://gateway.<host>.workers.dev ANTHROPIC_API_KEY=… \
  pnpm --filter agent start -- --question "Which segment grew the most?" [--asset 0x…] [--out path]
```

One process, no prompt, no confirmation: the run either reaches an answer or exits non-zero.
`out/answer.json` records the MCP session, the receipt hash and both Hedera transactions (settle
and consume), the dataset size, the model, the structured answer with its evidence, the
evidence values that do **not** appear verbatim in the dataset (`ungroundedEvidence`, empty on a
good run) and the timestamps of each leg.

| Variable | Meaning |
|---|---|
| `GATEWAY_URL` | deployed Access Gateway; the MCP endpoint is `${GATEWAY_URL}/mcp` |
| `ANTHROPIC_API_KEY` | Claude API key for the analysis (real inference, never cached) |
| `ANTHROPIC_MODEL` | optional, default `claude-sonnet-5` |
| `AGENT_QUESTION` | optional question for the CI spec |

## Tests

- `pnpm --filter agent test` runs the unit tests (argument parsing, asset choice, MCP result
  decoding against the real MCP SDK server transport in-process, `answer` tool decoding and the
  evidence grounding check) and `test/autonomous.spec.ts`, which is **skipped with a printed
  notice** unless `GATEWAY_URL` and `ANTHROPIC_API_KEY` are set. When they are, it performs the
  live run above and asserts: one MCP session, a bytes32 receipt, both on-chain transactions, a
  non-empty dataset, an answer whose every cited value is found verbatim in the decrypted data,
  the four legs in order, and the written `out/answer.json`.
- The payment wallet is the gateway's Privy server wallet (spend cap `MCP_SESSION_SPEND_CAP_TINYBAR`
  on the gateway side); this package holds no key of its own.

## Connect a real MCP client

The same three tools are what a live AI client uses. Claude Code, for example, registers the
remote server with the `claude mcp add --transport http rights-runtime <GATEWAY_URL>/mcp`
command, after which the assistant can discover, buy and decrypt on its own.
