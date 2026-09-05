import { describe, expect, it } from "vitest";

import { loadConfig } from "./config";

const base = {
  VITE_PRIVY_APP_ID: "app-123",
  VITE_RESOURCE_SERVER_URL: "http://localhost:4021",
};

describe("loadConfig", () => {
  it("reads values and fills Hedera testnet defaults", () => {
    expect(loadConfig(base)).toEqual({
      privyAppId: "app-123",
      resourceServerUrl: "http://localhost:4021",
      mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
    });
  });

  it("throws when the Privy app id is missing", () => {
    expect(() => loadConfig({ ...base, VITE_PRIVY_APP_ID: "" })).toThrow(
      "VITE_PRIVY_APP_ID",
    );
  });

  it("throws when the resource server URL is invalid", () => {
    expect(() =>
      loadConfig({ ...base, VITE_RESOURCE_SERVER_URL: "nope" }),
    ).toThrow("VITE_RESOURCE_SERVER_URL");
  });
});
