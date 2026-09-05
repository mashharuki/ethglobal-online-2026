import * as cdk from "aws-cdk-lib";
import { HederaSubgraphStack } from "../lib/hedera-subgraph-stack.js";

const app = new cdk.App();

const repoUrl =
  app.node.tryGetContext("repoUrl") ??
  "https://github.com/mashharuki/hedra-sample.git";
const repoBranch = app.node.tryGetContext("repoBranch") ?? "main";
const instanceType = app.node.tryGetContext("instanceType") ?? "t3.medium";
const allowedSshCidr = app.node.tryGetContext("allowedSshCidr") ?? undefined;

new HederaSubgraphStack(app, "HederaSubgraphStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1",
  },
  description: "Hedera MyToken (ERC-721) subgraph on a single EC2 host",
  repoUrl,
  repoBranch,
  instanceType,
  allowedSshCidr,
});
