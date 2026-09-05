# Agents and hackathons

## Primary sources

- https://github.com/hashgraph/hedera-agent-kit-js
- https://github.com/hedera-dev/scaffold-hbar/tree/templates/x402-pay-per-use
- https://github.com/matevszm/x402-hedera-example
- https://ethglobal.com/showcase/dive-5hxbp
- https://ethglobal.com/showcase/parkpulse-w84tg
- https://ethglobal.com/showcase/wafer-r4uab
- https://hedera.com/blog/these-are-the-winners-of-the-hello-future-origins-hackathon/

## Agent design

Hedera Agent Kit is a developer library, not an authorization system. Define:

- permitted tools and accounts;
- per-transaction and cumulative spend limits;
- assets and recipient allowlists;
- human confirmation thresholds and emergency stop;
- HCS audit records that contain action IDs/hashes, not sensitive prompt or customer data.

Use x402 only after confirming the currently supported asset, network, facilitator, settlement model, and key-management requirements. Do not treat a template as an operational payment service.

## Hackathon pattern

The strongest Hedera examples make a native primitive essential:

| Pattern | Primitive | Example direction |
| --- | --- | --- |
| Verifiable agent action | HCS + Agent Kit | Log signed decisions and approval state, then execute bounded payments. |
| Regulated/tokenized asset | HTS + EVM | Represent ownership/claims with HTS, implement lifecycle rules in Solidity. |
| Payment for a service | HBAR/x402 | Verify payment before issuing a time-limited resource or API response. |
| Real-world data/provenance | HCS + off-chain proofs | Anchor signed hashes from IoT, AI, or documents and provide verification UI. |

## Submission checklist

1. Publish a reproducible repository and a short end-to-end demo.
2. Deploy only the intended Testnet/Mainnet components and provide HashScan links when the event requires them.
3. Explain exactly which Hedera service is used, why a generic database or another EVM chain would not meet the same requirement, and which assumptions remain.
4. Demonstrate a failure/approval path, not only the happy path.

