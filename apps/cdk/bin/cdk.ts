import * as cdk from "aws-cdk-lib";
import { GraphNodeStack } from "../lib/graph-node-stack.js";

/**
 * apps/cdk entrypoint (tasks.md T013 / T054). All parameters are CDK context values with
 * defaults so `cdk synth` works without arguments; deploy is manual and outside CI:
 *   pnpm --filter cdk deploy -c allowedAdminCidr=203.0.113.4/32
 */
const app = new cdk.App();

const instanceType =
  (app.node.tryGetContext("instanceType") as string | undefined) ?? "t3.medium";
const ebsGb = Number(
  (app.node.tryGetContext("ebsGb") as string | undefined) ?? "30",
);
const hederaRpcUrl =
  (app.node.tryGetContext("hederaRpcUrl") as string | undefined) ??
  process.env.HEDERA_RPC_URL ??
  "https://testnet.hashio.io/api";
const allowedSshCidr = app.node.tryGetContext("allowedSshCidr") as
  | string
  | undefined;
const allowedAdminCidr = app.node.tryGetContext("allowedAdminCidr") as
  | string
  | undefined;

new GraphNodeStack(app, "GraphNodeStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region:
      process.env.CDK_DEFAULT_REGION ??
      process.env.AWS_REGION ??
      "ap-northeast-1",
  },
  description:
    "TrueCollective Rights Graph - self-hosted Graph Node on a single EC2 host (hackathon only)",
  instanceType,
  ebsGb,
  hederaRpcUrl,
  allowedSshCidr,
  allowedAdminCidr,
});
