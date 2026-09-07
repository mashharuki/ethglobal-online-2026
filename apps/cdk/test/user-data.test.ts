import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPOSE_PATH } from "../lib/graph-node-stack.js";
import { buildUserData } from "../lib/user-data.js";

const compose = readFileSync(DEFAULT_COMPOSE_PATH, "utf8");

const GRAPH_NODE_HOSTNAME = "54.123.45.67.sslip.io";

describe("buildUserData", () => {
  const script = buildUserData({
    composeYaml: compose,
    hederaRpcUrl: "https://testnet.hashio.io/api",
    graphNodeHostname: GRAPH_NODE_HOSTNAME,
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

  it("should write the Hedera relay URL and the Graph Node hostname to an owner-only .env consumed by compose", () => {
    expect(script).toContain(
      `umask 077 && printf 'HEDERA_RPC_URL=%s\\nGRAPH_NODE_HOSTNAME=%s\\n' 'https://testnet.hashio.io/api' '${GRAPH_NODE_HOSTNAME}' > /opt/graph-node/.env`,
    );
    expect(script).toContain("chmod 600 /opt/graph-node/.env");
    expect(compose).toContain('ethereum: "testnet:${HEDERA_RPC_URL}"');
  });

  it("should bake graphNodeHostname in directly rather than rediscovering it via IMDS at boot (#45)", () => {
    // The value must come from the caller (a CDK token resolved by CloudFormation at deploy
    // time, per graph-node-stack.ts) - not from a runtime self-query, which could otherwise
    // race the EIP association and capture a temporary auto-assigned public IP instead.
    expect(script).not.toContain("169.254.169.254");
    expect(script).not.toContain("public-ipv4");
    expect(script).not.toContain("16-76-149-54");
    expect(compose).toContain("https://${GRAPH_NODE_HOSTNAME}");
    expect(compose).not.toContain("16-76-149-54");
  });

  it("should reject a graphNodeHostname that could break out of the printf's single-quoting", () => {
    expect(() =>
      buildUserData({
        composeYaml: compose,
        hederaRpcUrl: "https://testnet.hashio.io/api",
        graphNodeHostname: "evil'; rm -rf / #",
      }),
    ).toThrow(/single quote/);
  });

  it("should reject a non-https relay URL and a compose file containing the heredoc terminator", () => {
    expect(() =>
      buildUserData({
        composeYaml: compose,
        hederaRpcUrl: "http://insecure",
        graphNodeHostname: GRAPH_NODE_HOSTNAME,
      }),
    ).toThrow(/https/);
    expect(() =>
      buildUserData({
        composeYaml: "x: __COMPOSE_EOF__",
        hederaRpcUrl: "https://ok",
        graphNodeHostname: GRAPH_NODE_HOSTNAME,
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
        () =>
          buildUserData({
            composeYaml: compose,
            hederaRpcUrl: url,
            graphNodeHostname: GRAPH_NODE_HOSTNAME,
          }),
        url,
      ).toThrow();
    }
    expect(() =>
      buildUserData({
        composeYaml: compose,
        hederaRpcUrl: "https://testnet.hashio.io/api?x=1&y=2",
        graphNodeHostname: GRAPH_NODE_HOSTNAME,
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
