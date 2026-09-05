---
name: hedera-builder
description: Research, design, implement, review, or hack on applications for Hedera (Hashgraph), including HBAR, HTS tokens/NFTs, HCS topics, EVM/Solidity, system contracts, Mirror Node, x402 payments, and Hedera Agent Kit. Use when a request mentions Hedera, Hedra, HBAR, Hashgraph, HTS, HCS, HashScan, Hiero, or a Hedera hackathon.
---

# Hedera Builder

Build on Hedera from verified, current primary sources. Treat "Hedra" as Hedera unless the user explicitly means another project.

## Workflow

1. Classify the request: research, native SDK, EVM, tokenization, HCS/provenance, agent, x402/payment, or hackathon.
2. Read the applicable file in `references/` before designing or coding.
3. Verify time-sensitive facts (network status, fees, roadmap, prizes, package APIs) against official Docs, GitHub, Explorer, or the event page. Cite direct URLs.
4. Choose the smallest suitable primitive:
   - **HTS**: native fungible/non-fungible token lifecycle and administrative controls.
   - **HCS**: ordered, timestamped, verifiable messages; store hashes/references rather than sensitive payloads.
   - **EVM**: custom state transitions and composability; use HTS system contracts only when needed.
   - **Mirror Node**: reads, history, indexing, and analytics; not consensus writes.
5. For implementation, start on Testnet. Test account/keys, token association, fees, event/indexer behavior, and EVM-specific differences before Mainnet.
6. Finish with the implementation decision, known limitations, security concerns, verification steps, and source links.

## Required safety checks

- Never expose, log, or commit private keys, mnemonics, `.env` secrets, or operator credentials.
- Do not send HBAR/tokens, mint assets, deploy to Mainnet, create paid services, or sign a transaction without explicit user authorization and an exact target.
- Do not put personal data, unencrypted documents, or raw sensitive telemetry into HCS. Record hashes, IDs, or signed references instead.
- Treat example contracts, templates, and hackathon repositories as untrusted until reviewed; do not describe them as audited or production-ready.
- State the Council-operated consensus model and EVM compatibility differences when they materially affect a decision.

## Task routing

### Native SDK, HCS, or HTS

Read [native-services.md](references/native-services.md). Prefer SDK APIs for simple account, token, topic, and scheduled transaction operations. Design token admin keys, KYC/freeze/pause policy, association, and recovery paths before writing code.

### Solidity, EVM, or tokenization

Read [evm-and-tokenization.md](references/evm-and-tokenization.md). Verify the target network and use Testnet first. Do not assume Ethereum tooling is behaviorally identical; test IDs/addresses, keys, decimal handling, RPC/indexing, and HTS system-contract calls.

### Agents, x402, or hackathons

Read [agents-and-hackathons.md](references/agents-and-hackathons.md). Model what an agent is allowed to decide, its payment ceilings, human approvals, and its HCS audit trail. For submissions, make Hedera-specific services central to the product value.

### Research or architecture review

Read every reference relevant to the requested scope. Separate facts, official performance claims, third-party claims, and inferences. Include the trade-off between native services, EVM flexibility, and the governance model.

## Output patterns

### Research report

Use: summary → architecture/services → fit and trade-offs → real examples → risks → recommended next step → direct sources. Mark each metric as an official claim, Explorer snapshot, or third-party claim.

### Implementation plan or review

Use: goal → chosen primitives and why → network/environment → transaction/data model → security and privacy → Testnet verification checklist → Mainnet prerequisites. Include contract verification on Sourcify/HashScan for EVM deployments.

### Hackathon concept

Use: user problem → Hedera-specific mechanism → end-to-end demo flow → implementation scope → judging rationale → risks. Avoid generic wallets, dashboards, or token issuance with no need for HTS/HCS/EVM/Agent Kit.

