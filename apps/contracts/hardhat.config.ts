import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import type { HardhatUserConfig } from "hardhat/config";
import { configVariable } from "hardhat/config";

/**
 * Hardhatの設定
 */
const config: HardhatUserConfig = {
  plugins: [hardhatToolboxMochaEthersPlugin, hardhatVerify],
  solidity: {
    profiles: {
      default: {
        version: "0.8.34",
        settings: {
          evmVersion: "cancun",
        },
      },
      production: {
        version: "0.8.34",
        settings: {
          evmVersion: "cancun",
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    // `default` is intentionally left as Hardhat's built-in simulated network so
    // `network.connect()` / `network.create()` in tests never need the keystore.
    testnet: {
      type: "http",
      url: configVariable("HEDERA_RPC_URL"),
      accounts: [configVariable("HEDERA_OPERATOR_KEY")],
    },
  },
  sourcify: {
    enabled: true,
  },
};

export default config;
