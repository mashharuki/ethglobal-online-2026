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
    expect(script).toContain("set -euo pipefail");
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

  it("should write the Hedera relay URL to an owner-only .env consumed by compose", () => {
    expect(script).toContain(
      "umask 077 && printf 'HEDERA_RPC_URL=%s\\n' 'https://testnet.hashio.io/api' > /opt/graph-node/.env",
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

  it("should reject relay URLs that could break out of the shell quoting or leak credentials", () => {
    const attacks = [
      "https://relay.example/'; rm -rf / #",
      "https://relay.example/api\nreboot",
      "https://relay.example/$(id)",
      "https://relay.example/`id`",
      "https://relay.example/a\\b",
      "https://relay.example/api with space",
      "https://user:secret@relay.example/api",
    ];
    for (const url of attacks) {
      expect(
        () => buildUserData({ composeYaml: compose, hederaRpcUrl: url }),
        url,
      ).toThrow();
    }
    expect(() =>
      buildUserData({
        composeYaml: compose,
        hederaRpcUrl: "https://testnet.hashio.io/api?x=1&y=2",
      }),
    ).not.toThrow();
  });

  it("should not trace commands (no set -x) and must fail the boot when graph-node never answers", () => {
    expect(script).not.toContain("set -euxo");
    expect(script).not.toContain("set -x");
    expect(script).toContain("curl -fsS --max-time 5 http://127.0.0.1:8030/");
    expect(script).toContain('if [ "$READY" != "1" ]; then');
    expect(script).toContain("exit 1");
  });

  it("should capture output to a log file and write a readiness marker", () => {
    expect(script).toContain("/var/log/graph-node-userdata.log");
    expect(script).toContain("echo graph-node-ready > /opt/graph-node/READY");
  });
});
