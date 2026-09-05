import { describe, expect, it } from "vitest";

import { loadConfig } from "./config";

const base = {
  VITE_PRIVY_APP_ID: "app-123",
  VITE_GATEWAY_URL: "http://localhost:8787/",
};

describe("loadConfig", () => {
  it("should read values and fill Hedera testnet defaults", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      privyAppId: "app-123",
      gatewayUrl: "http://localhost:8787",
      rpcUrl: "https://testnet.hashio.io/api",
      mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
      ipfsGatewayUrl: "https://ipfs.io",
    });
    expect(config.deployment.chainId).toBe(296);
  });

  it("should take contract addresses from the environment", () => {
    const config = loadConfig({
      ...base,
      VITE_RIGHTS_NFT_ADDRESS: "0x1111111111111111111111111111111111111111",
      VITE_RIGHTS_REGISTRY_ADDRESS:
        "0x2222222222222222222222222222222222222222",
    });
    expect(config.deployment.rightsNFT).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });

  it("should throw when the Privy app id is missing", () => {
    expect(() => loadConfig({ ...base, VITE_PRIVY_APP_ID: "" })).toThrow(
      "VITE_PRIVY_APP_ID",
    );
  });

  it("should throw when the gateway URL is invalid", () => {
    expect(() => loadConfig({ ...base, VITE_GATEWAY_URL: "nope" })).toThrow(
      "VITE_GATEWAY_URL",
    );
  });
});
