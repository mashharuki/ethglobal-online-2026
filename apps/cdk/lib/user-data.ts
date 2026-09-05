import * as ec2 from "aws-cdk-lib/aws-ec2";

export interface UserDataOptions {
  readonly repoUrl: string;
  readonly repoBranch: string;
}

/**
 * EC2 の cloud-init 用スクリプトを組み立てる。
 * 実処理は clone 後の deploy/ec2-bootstrap.sh に委譲し、ここは環境準備のみ。
 */
export function buildUserData(opts: UserDataOptions): ec2.UserData {
  const ud = ec2.UserData.forLinux();
  ud.addCommands(
    "set -euxo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "exec > >(tee -a /var/log/subgraph-userdata.log) 2>&1",
    "apt-get update -y",
    "apt-get install -y ca-certificates curl git jq netcat-openbsd",
    // Docker 公式リポジトリ（コードネームは一旦変数に取り、ネストクォートを避ける）
    "install -m 0755 -d /etc/apt/keyrings",
    "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
    "chmod a+r /etc/apt/keyrings/docker.asc",
    'UBUNTU_CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")',
    "DEB_ARCH=$(dpkg --print-architecture)",
    'echo "deb [arch=${DEB_ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME} stable" > /etc/apt/sources.list.d/docker.list',
    "apt-get update -y",
    "apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
    "systemctl enable --now docker",
    // Node.js 20
    "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
    "apt-get install -y nodejs",
    "npm install -g pnpm@10",
    // アプリ取得
    `git clone --branch ${opts.repoBranch} --depth 1 ${opts.repoUrl} /opt/app`,
    "chmod +x /opt/app/hedera-subgraph-example/deploy/ec2-bootstrap.sh",
    "bash /opt/app/hedera-subgraph-example/deploy/ec2-bootstrap.sh",
  );
  return ud;
}
