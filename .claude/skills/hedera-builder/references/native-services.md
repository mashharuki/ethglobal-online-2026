# Native services

## Primary sources

- https://docs.hedera.com/learn/getting-started/what-is-hedera
- https://docs.hedera.com/native/tokens/token-id
- https://docs.hedera.com/native/consensus/create-topic
- https://docs.hedera.com/

## Selection guide

| Need | Choose | Design check |
| --- | --- | --- |
| Fungible token, NFT, transfer restrictions | HTS | Specify supply, treasury, admin/supply/KYC/freeze/pause/wipe keys, token association, and recovery/rotation. |
| Ordered, timestamped proof of an event | HCS | Store a content hash or signed reference, define topic keys and retention/query strategy. |
| Custom application state or contract composability | Smart Contract Service | Assess whether EVM is necessary; test all Hedera differences. |
| Historical reads, events, balances, analytics | Mirror Node | Use as a read/indexing layer; do not use it to write consensus transactions. |

## Native implementation checklist

1. Create a Testnet account through the Portal; fund only with test HBAR.
2. Identify the operator and payer account. Keep secrets in untracked environment variables or a managed secret store.
3. For HTS, test create, associate, transfer, and each enabled administrative operation.
4. For HCS, test topic creation, submit, and retrieval through a Mirror Node; verify the message schema is versioned.
5. Measure fees on the target operation rather than applying a network-wide average.

## Design cautions

- An on-ledger timestamp establishes ordering and consensus for a submitted message; it does not prove an external event was true.
- Token administrative powers are product and regulatory decisions, not mere implementation details. Document who controls each key and under which approval policy.
- Do not write PII or confidential raw data to a public topic.

