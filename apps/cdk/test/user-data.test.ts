import { describe, expect, it } from "vitest";
import { buildUserData } from "../lib/user-data.js";

describe("buildUserData", () => {
  const script = buildUserData({
    repoUrl: "https://github.com/example/repo.git",
    repoBranch: "main",
  }).render();

  it("starts with a bash shebang", () => {
    expect(script.startsWith("#!/bin/bash")).toBe(true);
  });

  it("installs docker and node, then clones the given repo/branch", () => {
    expect(script).toContain("docker-compose-plugin");
    expect(script).toContain("setup_20.x");
    expect(script).toContain(
      "git clone --branch main --depth 1 https://github.com/example/repo.git /opt/app",
    );
  });

  it("delegates real work to ec2-bootstrap.sh", () => {
    expect(script).toContain(
      "bash /opt/app/hedera-subgraph-example/deploy/ec2-bootstrap.sh",
    );
  });

  it("captures output to a log file", () => {
    expect(script).toContain("/var/log/subgraph-userdata.log");
  });
});
