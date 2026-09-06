import * as ec2 from "aws-cdk-lib/aws-ec2";

export interface UserDataOptions {
  /** docker-compose.graph-node.yml content, embedded verbatim (no git clone on the host). */
  readonly composeYaml: string;
  /** Hedera JSON-RPC relay used as the graph-node `ethereum` provider (public URL, no credentials). */
  readonly hederaRpcUrl: string;
}

const COMPOSE_DIR = "/opt/graph-node";
const LOG_FILE = "/var/log/graph-node-userdata.log";
const HEREDOC_EOF = "__COMPOSE_EOF__";

/**
 * The relay URL is interpolated into a root shell script and a compose `.env` file, so it is
 * restricted to a conservative URL alphabet: no quotes, whitespace, control characters, `$`,
 * backticks or backslashes, and no userinfo (credentials would end up in CloudFormation and logs).
 */
function validateRelayUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("hederaRpcUrl must be a valid URL");
  }
  if (parsed.protocol !== "https:")
    throw new Error("hederaRpcUrl must be an https URL");
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      "hederaRpcUrl must not contain credentials (they would be stored in plain text)",
    );
  }
  if (!/^[A-Za-z0-9\-._~:/?#[\]@!&()*+,;=%]+$/.test(value)) {
    throw new Error(
      "hederaRpcUrl contains characters that are not allowed in user-data",
    );
  }
  return value;
}

/**
 * cloud-init script for the Graph Node host: install Docker, write the compose file and
 * its .env, start the stack, and fail the boot (non-zero exit) if graph-node never answers.
 * No `set -x`: the script must not echo configuration values into the cloud-init log.
 */
export function buildUserData(opts: UserDataOptions): ec2.UserData {
  const relay = validateRelayUrl(opts.hederaRpcUrl);
  if (opts.composeYaml.includes(HEREDOC_EOF)) {
    throw new Error("compose content must not contain the heredoc terminator");
  }
  const ud = ec2.UserData.forLinux();
  ud.addCommands(
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    `exec > >(tee -a ${LOG_FILE}) 2>&1`,
    'echo "[graph-node] installing docker"',
    "apt-get update -y",
    "apt-get install -y ca-certificates curl jq",
    "install -m 0755 -d /etc/apt/keyrings",
    "curl -fsSL --max-time 60 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
    "chmod a+r /etc/apt/keyrings/docker.asc",
    'UBUNTU_CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")',
    "DEB_ARCH=$(dpkg --print-architecture)",
    'echo "deb [arch=${DEB_ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME} stable" > /etc/apt/sources.list.d/docker.list',
    "apt-get update -y",
    "apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin",
    "systemctl enable --now docker",
    'echo "[graph-node] writing compose stack"',
    `mkdir -p ${COMPOSE_DIR}/data/ipfs ${COMPOSE_DIR}/data/postgres`,
    // Preserve Compose variable expressions until Docker Compose reads the generated .env.
    `cat > ${COMPOSE_DIR}/docker-compose.yml <<'${HEREDOC_EOF}'`,
    opts.composeYaml.trimEnd(),
    HEREDOC_EOF,
    `umask 077 && printf 'HEDERA_RPC_URL=%s\\n' '${relay}' > ${COMPOSE_DIR}/.env`,
    `chmod 600 ${COMPOSE_DIR}/.env`,
    `cd ${COMPOSE_DIR} && docker compose up -d`,
    'echo "[graph-node] waiting for graph-node index status endpoint"',
    "READY=0",
    "for i in $(seq 1 60); do if curl -fsS --max-time 5 http://127.0.0.1:8030/ >/dev/null 2>&1; then READY=1; break; fi; sleep 5; done",
    `if [ "$READY" != "1" ]; then echo "[graph-node] FAILED: graph-node did not become ready" >&2; exit 1; fi`,
    `echo graph-node-ready > ${COMPOSE_DIR}/READY`,
    'echo "[graph-node] ready"',
  );
  return ud;
}
