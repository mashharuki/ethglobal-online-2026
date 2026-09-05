# Sample Hardhat 3 Project (`mocha` and `ethers`)

This project showcases a Hardhat 3 project using `mocha` for tests and the `ethers` library for Ethereum interactions.

To learn more about Hardhat 3, please visit the [Getting Started guide](https://hardhat.org/docs/getting-started#getting-started-with-hardhat-3). To share your feedback, join our [Hardhat 3](https://hardhat.org/hardhat3-telegram-group) Telegram group or [open an issue](https://github.com/NomicFoundation/hardhat/issues/new) in our GitHub issue tracker.

## Project Overview

This example project includes:

- A simple Hardhat configuration file.
- Foundry-compatible Solidity unit tests.
- TypeScript integration tests using `mocha` and ethers.js
- Examples demonstrating how to connect to different types of networks, including locally simulating OP mainnet.

## Usage

### Setup

```bash
npx hardhat keystore set HEDERA_RPC_URL
npx hardhat keystore set HEDERA_PRIVATE_KEY
```

テストネットの場合は`https://testnet.hashio.io/api`を設定する。

以下のコマンドで設定状態を確認

```bash
npx hardhat keystore list
```

### Running Tests

To run all the tests in the project, execute the following command:

```shell
npx hardhat test
```

You can also selectively run the Solidity or `mocha` tests:

```shell
npx hardhat test solidity
npx hardhat test mocha
```

### Run console

```bash
bun run console --network testnet
```

### Make a deployment to Sepolia

This project includes an example Ignition module to deploy the contract. You can deploy this module to a locally simulated chain or to Sepolia.

To run the deployment to a local chain:

```shell
npx hardhat ignition deploy ignition/modules/Counter.ts
```

To run the deployment to Sepolia, you need an account with funds to send the transaction. The provided Hardhat configuration includes a Configuration Variable called `SEPOLIA_PRIVATE_KEY`, which you can use to set the private key of the account you want to use.

You can set the `SEPOLIA_PRIVATE_KEY` variable using the `hardhat-keystore` plugin or by setting it as an environment variable.

To set the `SEPOLIA_PRIVATE_KEY` config variable using `hardhat-keystore`:

```shell
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
```

After setting the variable, you can run the deployment with the Sepolia network:

```shell
npx hardhat ignition deploy --network sepolia ignition/modules/Counter.ts
```

### Verify

```bash
bunx hardhat verify --network testnet 0x94f5c9f6A59c257823FA5fECd8E7A15F8Ed94029 0xcA341CE4902756bF9e96e145014DD0aB36A0Fe8E
```

```bash
=== Etherscan ===
[hardhat-keystore] Enter the password: ********
HHE80000: The network "testnet" with chain id "296" is not supported.

=== Blockscout ===
HHE80000: The network "testnet" with chain id "296" is not supported.

=== Sourcify ===

📤 Submitted source code for verification on Sourcify:

  contracts/MyToken.sol:MyToken
  Address: 0x94f5c9f6A59c257823FA5fECd8E7A15F8Ed94029

⏳ Waiting for verification result...


The initial verification attempt for contracts/MyToken.sol:MyToken failed using the minimal compiler input.

Trying again with the full solc input used to compile and deploy the contract.
Unrelated contracts may be displayed on Sourcify as a result.


📤 Submitted source code for verification on Sourcify:

  contracts/MyToken.sol:MyToken
  Address: 0x94f5c9f6A59c257823FA5fECd8E7A15F8Ed94029

⏳ Waiting for verification result...


✅ Contract verified successfully on Sourcify!

  contracts/MyToken.sol:MyToken
  Explorer: https://sourcify.dev/server/repo-ui/296/0x94f5c9f6A59c257823FA5fECd8E7A15F8Ed94029
```

[Verified Contract](https://hashscan.io/testnet/contract/0.0.10290464)