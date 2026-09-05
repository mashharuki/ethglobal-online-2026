# EVM and tokenization

## Primary sources

- https://docs.hedera.com/evm
- https://docs.hedera.com/hedera/smart-contracts/hts-system-contracts
- https://docs.hedera.com/evm/tutorials/intermediate/verify-hashscan
- https://github.com/hashgraph/hedera-smart-contracts
- https://www.npmjs.com/package/@hiero-ledger/hiero-contracts

## Architecture choice

- Use **HTS** for standard token lifecycle operations and built-in token controls.
- Use **EVM/Solidity** for custom state machines, DeFi logic, and composability.
- Use **hybrid tokenization** when Solidity needs to control or integrate a native HTS asset. Keep the boundary explicit in the specification.

## System contracts

The official interface repository documents HTS at `0x167`, Hedera Account Service at `0x16a`, Exchange Rate at `0x168`, and PRNG at `0x169`. Confirm current interfaces from official sources before coding. The repository's example/reference contracts are not a substitute for a security review.

## EVM checklist

1. Use chain ID `296` for Testnet and `295` for Mainnet; verify the RPC provider and wallet configuration.
2. Validate ECDSA secp256k1 signing for EVM transactions and understand any native account/key interaction.
3. Test native `shard.realm.num` IDs and EVM `0x` addresses at every boundary.
4. Test HBAR decimal handling, token association, gas estimation, logs, and indexer queries.
5. Compile deterministically, retain compiler metadata, verify with Sourcify, then confirm the result on HashScan.
6. Run a security review covering access control, reentrancy, token keys, upgradeability, price/oracle assumptions, and the HTS/EVM boundary.

