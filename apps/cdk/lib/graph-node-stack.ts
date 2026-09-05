import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { buildUserData } from "./user-data.js";

export interface GraphNodeStackProps extends cdk.StackProps {
  /** EC2 instance type (day1 probe T021 decides; t3.medium is the default) */
  readonly instanceType: string;
  /** Root EBS size in GB (graph-node + postgres + ipfs data) */
  readonly ebsGb: number;
  /** Hedera JSON-RPC relay used as the graph-node ethereum provider */
  readonly hederaRpcUrl: string;
  /** Opens 22/tcp to this CIDR only (emergency SSH; SSM is the default access path) */
  readonly allowedSshCidr?: string;
  /** Opens the admin ports (8020 graph deploy, 5001 ipfs) to this CIDR only */
  readonly allowedAdminCidr?: string;
  /** Override the compose file content (tests); defaults to docker/docker-compose.graph-node.yml */
  readonly composeYaml?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_COMPOSE_PATH = resolve(
  here,
  "../docker/docker-compose.graph-node.yml",
);
export const SUBGRAPH_NAME = "truecollective/rights-graph";

/**
 * GraphNodeStack (tasks.md T054): one EC2 host + Elastic IP + Security Group + EBS running the
 * self-hosted Graph Node stack via docker compose. Hackathon-duration-only; `cdk destroy` after
 * the event (constitution VII / DoD #7). Query port 8000 is public; admin ports are CIDR-gated.
 */
export class GraphNodeStack extends cdk.Stack {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: GraphNodeStackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    const securityGroup = new ec2.SecurityGroup(this, "GraphNodeSg", {
      vpc,
      description:
        "TrueCollective Graph Node - GraphQL public, admin CIDR-gated",
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8000),
      "GraphQL query endpoint",
    );
    if (props.allowedAdminCidr) {
      const admin = ec2.Peer.ipv4(props.allowedAdminCidr);
      securityGroup.addIngressRule(
        admin,
        ec2.Port.tcp(8020),
        "graph-node admin (graph deploy)",
      );
      securityGroup.addIngressRule(
        admin,
        ec2.Port.tcp(5001),
        "IPFS API (graph deploy upload)",
      );
      securityGroup.addIngressRule(
        admin,
        ec2.Port.tcp(8030),
        "index-node status",
      );
    }
    if (props.allowedSshCidr) {
      securityGroup.addIngressRule(
        ec2.Peer.ipv4(props.allowedSshCidr),
        ec2.Port.tcp(22),
        "Emergency SSH",
      );
    }

    const role = new iam.Role(this, "GraphNodeInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore",
        ),
      ],
    });

    const machineImage = ec2.MachineImage.fromSsmParameter(
      "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
      { os: ec2.OperatingSystemType.LINUX },
    );

    const composeYaml =
      props.composeYaml ?? readFileSync(DEFAULT_COMPOSE_PATH, "utf8");
    const userData = buildUserData({
      composeYaml,
      hederaRpcUrl: props.hederaRpcUrl,
    });

    this.instance = new ec2.Instance(this, "GraphNodeHost", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage,
      securityGroup,
      role,
      requireImdsv2: true,
      associatePublicIpAddress: true,
      userData,
      userDataCausesReplacement: true,
      blockDevices: [
        {
          deviceName: "/dev/sda1",
          volume: ec2.BlockDeviceVolume.ebs(props.ebsGb, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });
    cdk.Tags.of(this).add("Project", "truecollective");
    cdk.Tags.of(this).add("Lifecycle", "hackathon-only-destroy-after-event");

    const eip = new ec2.CfnEIP(this, "GraphNodeEip", {
      domain: "vpc",
      tags: [{ key: "Name", value: "truecollective-graph-node" }],
    });
    new ec2.CfnEIPAssociation(this, "GraphNodeEipAssoc", {
      allocationId: eip.attrAllocationId,
      instanceId: this.instance.instanceId,
    });

    new cdk.CfnOutput(this, "ElasticIp", { value: eip.ref });
    new cdk.CfnOutput(this, "InstanceId", { value: this.instance.instanceId });
    new cdk.CfnOutput(this, "GraphqlUrl", {
      value: `http://${eip.ref}:8000/subgraphs/name/${SUBGRAPH_NAME}`,
    });
    new cdk.CfnOutput(this, "GraphNodeAdminUrl", {
      value: `http://${eip.ref}:8020/`,
    });
    new cdk.CfnOutput(this, "IpfsUrl", { value: `http://${eip.ref}:5001` });
    new cdk.CfnOutput(this, "SsmStartSessionCommand", {
      value: `aws ssm start-session --target ${this.instance.instanceId} --region ${this.region}`,
    });
  }
}
