# ETHOnline 2026 Showcase text (tasks.md T126)

> 提出フォームへ貼る英文の下書き。事実関係の正本は README（Verification status / Prior work /
> Sponsor tracks）と `specs/001-rights-runtime-mvp/`。**ライブ検証が未了の項目は「verified locally」
> のまま提出し、デプロイ後に `<placeholder>` を埋めて更新する**（憲章 VII: 正直な主張）。
> 締切 2026-09-13 12:00 EDT（09-14 01:00 JST）。partner prize は 3 枠: Hedera「AI & Agentic
> Payments」/ Privy「Best Financial Flow」/ Privy「Best B2B Financial Product」。

## Project name

TrueCollective

## Tagline (≤ 100 chars)

When the NFT moves, owner access and future revenue move with it; paid licenses keep their terms.

## Short description (≤ 280 chars)

NFT ownership and the actual right to use the content drift apart once a token is resold. TrueCollective keeps them in sync on Hedera: each transfer revokes the old owner's access, grants the new one, keeps paid licenses that should survive, and redirects future revenue.

## Description

**The problem.** Today an NFT is a pointer. Whoever holds the key material, the CDN token or the
API subscription keeps using the content after selling the token, and buyers of "access passes"
lose them when the underlying asset changes hands. Nothing on chain says who may decrypt what,
for how long, and who gets paid next.

**What we built.** TrueCollective is a *transfer-coupled rights runtime* on Hedera Testnet, driven
by two independent epoch counters:

- **Owner Epoch** (`RightsNFT.accessEpoch`) is bumped inside the ERC-721 `_update` hook on every
  transfer, so the previous owner's free-access session dies on the next request and the new owner's
  starts, with no off-chain revocation list.
- **License Epoch** (`RightsRegistry.licenseEpoch`) governs *purchased* rights. A paid grant is an
  EIP-712 **Rights Receipt** whose hash is the on-chain authorization key; each receipt carries a
  `transferMode`, so a `SURVIVE_TRANSFER` license keeps working across a sale while an
  `INVALIDATE_ON_TRANSFER` one is cut, and future revenue is reassigned to the new owner without
  touching already-settled payouts.

Around the contracts sits an **Access Gateway** (Hono on Cloudflare Workers) that re-derives every
authorization from on-chain reads (`ownerOf`, `accessEpoch`, `receiptStatus`) on every request; a
**KeyGate** that releases one half of a split content key only after that check; **x402 payments in
native HBAR** through the Blocky402 facilitator that settle into a Rights Receipt; a self-hosted
**Rights Graph** subgraph for discovery and audit (never for authorization); and an **MCP server**
(`discover_assets` → `buy_access` → `decrypt_content`) so an AI agent can find a dataset, pay for
it and analyse it with zero human steps, paying from a **Privy server wallet** that never exposes a
raw key to the gateway.

Revocation is forward-looking: an epoch bump stops the *next* request; it cannot claw back
plaintext or key shares a party already decrypted, and the gateway remains a trusted component
for the owner path (README → Trust model states the residual trust points explicitly).

**Why it matters.** Creators can sell datasets, media or research with rights that actually follow
the token; buyers of licenses know exactly what survives a resale; and AI agents get a paid data
market they can use autonomously, with a hard per-session spend cap.

**What is verified today.** Contract suites (including the 20-parallel replay test), the gateway
suites on workerd + PGlite, the web and agent unit suites and the mock-free audit of the core path
are green in CI. Live Testnet deployment, Blocky402 settlement and the autonomous agent run are
the pending acceptance gates; every live spec skips with a printed notice rather than reporting
success (see README → Verification status). <update this paragraph after deployment>

## How it's made

- **Contracts**: Solidity 0.8.34, Hardhat 3, OpenZeppelin 5. `RightsNFT` (ERC-721 + `accessEpoch`)
  and `RightsRegistry` (atomic `settleAndIssue{value}` in native HBAR, receipt lifecycle with a
  strictly increasing `useIndex`, 2-party revenue split creator/owner, `bumpLicenseEpoch` for
  emergency revocation). Golden tests pin the EIP-712 `receiptHash` on both the Solidity and the
  TypeScript side so the two can never drift.
- **Gateway**: Hono on Cloudflare Workers with Durable Objects (`ReceiptLock` serialises
  `consume` per receipt; `OperatorTxQueue` serialises operator nonces), Workers KV for the
  KEK-encrypted key shares, Postgres via Hyperdrive with `UNIQUE(receipt_hash, use_index)` as the
  exactly-once backstop. Authorization is decided by fresh `eth_call`s, never by cache or index.
- **Payments**: x402 (`hedera:testnet` / `exact` / native asset) via the Blocky402 facilitator;
  `payment_id = keccak256(X-PAYMENT)` makes replays idempotent and a stage machine makes crashes
  resumable. The contract operation `settleAndIssue{value}` is atomic (payment, revenue split and
  receipt in one transaction); on the default *custodial* rail the facilitator first settles the
  buyer's HBAR transfer to a settlement account and the operator then anchors the receipt, so there
  is a short non-atomic window that we disclose rather than hide (a value-attached contract call
  through the facilitator is the primary rail if the day-1 probe proves it works). Web buyers sign
  the Hedera transfer with their Privy embedded wallet; the MCP agent
  signs with a Privy server wallet (`eth_signTypedData_v4` for challenges, `secp256k1_sign` for the
  transaction digest).
- **Discovery / audit**: a Graph Node self-hosted on a single EC2 (AWS CDK + docker-compose) indexes
  `Transfer` / `ReceiptIssued` / `ReceiptConsumed` / `RevenueAllocated` for the market view and the
  Rights Graph dashboard. Hedera is not supported by Subgraph Studio, which is why we host our own
  and do not enter The Graph track.
- **Web**: Vite + React + Tailwind + Privy; client-side decryption in the browser; a split-screen
  demo shows, after one transfer, the old owner rejected (`OWNER_EPOCH_MISMATCH`) next to a
  surviving third-party license still decrypting.
- **AI agent**: `apps/agent` is a CI harness that connects to `/mcp`, runs the three tools and asks
  Claude to analyse the decrypted dataset; the harness re-checks the model's answer against the
  data itself so "autonomous" is verifiable, not asserted.
- **Shared contract**: `packages/shared` (error codes, EIP-712 types, manifest schema, KV format)
  and `packages/openapi` (OpenAPI 3.1 → generated types) so frontend/backend drift is a `tsc`
  error.
- **Process**: Spec-Driven Development with GitHub Spec Kit; the constitution, spec, plan,
  research, data model, contracts and tasks live in `specs/001-rights-runtime-mvp/` and
  `.specify/`. Claude Code wrote most of the implementation; every PR was reviewed by a second model
  (GPT-6 Astra via Codex) until clean, plus human review. Adversarial tests (a 14-row error matrix)
  were written before the implementation, per the constitution.

## Sponsor integrations (partner prizes: max 3)

> Status wording below is deliberate: "implemented" = code + local tests exist; "pending" = not
> yet exercised against the live network. Replace the pending clauses with facts (URLs, addresses,
> transaction links) after deployment, and remove any clause that still cannot be demonstrated.

- **Hedera — AI & Agentic Payments on Hedera.** The x402-gated Access Gateway targets Hedera
  Testnet through the Blocky402 facilitator (facilitator client, custodial/primary/fallback rails
  and the MCP tools are implemented and unit-tested). **Pending:** the live deployment of the
  gateway, the first real paid request completed end-to-end by the MCP agent in native HBAR, and
  HashScan verification of `RightsNFT` / `RightsRegistry` (<addresses after deployment>). Setup,
  architecture and the payment flow are in the README.
- **Privy — Best Financial Flow.** Owners and buyers log in with the Privy embedded wallet, and the
  full flow (x402 payment in HBAR → on-chain receipt → revenue split creator/owner → decrypt) is
  implemented with Privy at the centre of the transfer, not as a decorative login. **Pending:** one
  live run of that flow against the deployed gateway.
- **Privy — Best B2B Financial Product.** The MCP payment wallet is a Privy server wallet: the
  gateway never holds the key and every signature is a Privy RPC; each MCP session is bound to the
  receipts it bought and capped by a hard per-session spend limit enforced in the gateway. The B2B
  use case is a data provider selling licensed datasets to autonomous agents with auditable,
  capped spending. **Pending / to decide:** whether to add a Privy authorization key on the server
  wallet so a Privy-side control is demonstrably in the loop (see
  `docs/submission/prize-requirements.md` §3).

## Links

- Repository: https://github.com/mashharuki/ethglobal-online-2026
- Live gateway / MCP endpoint: <https://…workers.dev/mcp>
- Web app: <https://…pages.dev>
- Demo video (2–4 min, narrated): <URL>
- Spec Kit artifacts: `specs/001-rights-runtime-mvp/`, `.specify/memory/constitution.md`

## AI assistance and prior work (required disclosures)

AI tools were used throughout: Claude Code for implementation and Codex (GPT-6 Astra) for review;
the spec files and prompts are in the repository. All commits are dated 2026-09-05 or later. Public
boilerplate copied from the `hedra-sample` Hedera examples (Hardhat ERC-721 mint, subgraph example,
x402 + Privy web sample) predates the event and contains no TrueCollective logic. The design
documents under `specs/` and `.specify/` were written 2026-09-02 → 03 with Spec Kit, before the
event opened; we disclose this explicitly. The ETHOnline AI policy permits spec-driven workflows
when the spec files and prompts are included in the repository (they are), while the From Scratch
track asks that project-specific work start after the event opens — we leave the judgement of
how pre-event *design documents* fall between those two rules to the organizers rather than
assert it ourselves. Details: README → "Prior work and disclosure".
