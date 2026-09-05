import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPOSE_PATH } from "../lib/graph-node-stack.js";
import { buildUserData } from "../lib/user-data.js";

const compose = readFileSync(DEFAULT_COMPOSE_PATH, "utf8");

describe("buildUserData", () => {
  const script = buildUserData({
    composeYaml: compose,
    hederaRpcUrl: "https://testnet.hashio.io/api",
  }).render();

  it("should start with a bash shebang and fail fast", () => {
    expect(script.startsWith("#!/bin/bash")).toBe(true);
    expect(script).toContain("set -euxo pipefail");
  });

  it("should install docker + compose plugin and never clone a repository", () => {
    expect(script).toContain("docker-compose-plugin");
    expect(script).not.toContain("git clone");
  });

  it("should embed the compose file verbatim inside a quoted heredoc and start it", () => {
    expect(script).toContain("<<'__COMPOSE_EOF__'");
    expect(script).toContain("image: graphprotocol/graph-node:v0.27.0");
    expect(script).toContain("cd /opt/graph-node && docker compose up -d");
  });

  it("should write the Hedera relay URL to a 0600 .env consumed by compose", () => {
    expect(script).toContain(
      "'https://testnet.hashio.io/api' > /opt/graph-node/.env",
    );
    expect(script).toContain("chmod 600 /opt/graph-node/.env");
    expect(compose).toContain('ethereum: "testnet:${HEDERA_RPC_URL}"');
  });

  it("should reject a non-https relay URL and a compose file containing the heredoc terminator", () => {
    expect(() =>
      buildUserData({ composeYaml: compose, hederaRpcUrl: "http://insecure" }),
    ).toThrow(/https/);
    expect(() =>
      buildUserData({
        composeYaml: "x: __COMPOSE_EOF__",
        hederaRpcUrl: "https://ok",
      }),
    ).toThrow(/terminator/);
  });

  it("should capture output to a log file and write a readiness marker", () => {
    expect(script).toContain("/var/log/graph-node-userdata.log");
    expect(script).toContain("echo graph-node-ready > /opt/graph-node/READY");
  });
});
