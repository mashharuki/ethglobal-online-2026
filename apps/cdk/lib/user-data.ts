import * as ec2 from "aws-cdk-lib/aws-ec2";

export interface UserDataOptions {
  /** docker-compose.graph-node.yml content, embedded verbatim (no git clone on the host). */
  readonly composeYaml: string;
  /** Hedera JSON-RPC relay used as the graph-node `ethereum` provider. */
  readonly hederaRpcUrl: string;
}

const COMPOSE_DIR = "/opt/graph-node";
const LOG_FILE = "/var/log/graph-node-userdata.log";

/**
 * cloud-init script for the Graph Node host: install Docker, write the compose file and
 * its .env, start the stack. Idempotent enough to re-run on instance replacement.
 * Real work stays in the compose file so the script is short and reviewable.
 */
export function buildUserData(opts: UserDataOptions): ec2.UserData {
  if (!opts.hederaRpcUrl.startsWith("https://")) {
    throw new Error("hederaRpcUrl must be an https URL");
  }
  if (opts.composeYaml.includes("__COMPOSE_EOF__")) {
    throw new Error("compose content must not contain the heredoc terminator");
  }
  const ud = ec2.UserData.forLinux();
  ud.addCommands(
    "set -euxo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    `exec > >(tee -a ${LOG_FILE}) 2>&1`,
    "apt-get update -y",
    "apt-get install -y ca-certificates curl jq",
    // Docker official repository
    "install -m 0755 -d /etc/apt/keyrings",
    "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
    "chmod a+r /etc/apt/keyrings/docker.asc",
    'UBUNTU_CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")',
    "DEB_ARCH=$(dpkg --print-architecture)",
    'echo "deb [arch=${DEB_ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME} stable" > /etc/apt/sources.list.d/docker.list',
    "apt-get update -y",
    "apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin",
    "systemctl enable --now docker",
    // compose stack
    `mkdir -p ${COMPOSE_DIR}/data/ipfs ${COMPOSE_DIR}/data/postgres`,
    `cat > ${COMPOSE_DIR}/docker-compose.yml <<'__COMPOSE_EOF__'`,
    opts.composeYaml.trimEnd(),
    "__COMPOSE_EOF__",
    `printf 'HEDERA_RPC_URL=%s\\n' '${opts.hederaRpcUrl}' > ${COMPOSE_DIR}/.env`,
    `chmod 600 ${COMPOSE_DIR}/.env`,
    `cd ${COMPOSE_DIR} && docker compose up -d`,
    // readiness marker for the probe script
    `for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8030/ >/dev/null 2>&1 && break; sleep 5; done`,
    `echo graph-node-ready > ${COMPOSE_DIR}/READY`,
  );
  return ud;
}
