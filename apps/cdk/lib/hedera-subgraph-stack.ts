import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { buildUserData } from "./user-data.js";

export interface HederaSubgraphStackProps extends cdk.StackProps {
  /** userData が clone する Git リポジトリ URL */
  readonly repoUrl: string;
  /** clone するブランチ */
  readonly repoBranch: string;
  /** EC2 インスタンスタイプ（例: "t3.medium"） */
  readonly instanceType: string;
  /** 指定時のみ 22/tcp をこの CIDR に対して開放する */
  readonly allowedSshCidr?: string;
}

export class HederaSubgraphStack extends cdk.Stack {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: HederaSubgraphStackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    const securityGroup = new ec2.SecurityGroup(this, "SubgraphSg", {
      vpc,
      description: "Hedera subgraph host - GraphQL query port only",
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8000),
      "GraphQL query endpoint",
    );
    if (props.allowedSshCidr) {
      securityGroup.addIngressRule(
        ec2.Peer.ipv4(props.allowedSshCidr),
        ec2.Port.tcp(22),
        "Emergency SSH",
      );
    }

    const role = new iam.Role(this, "SubgraphInstanceRole", {
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

    const userData = buildUserData({
      repoUrl: props.repoUrl,
      repoBranch: props.repoBranch,
    });

    this.instance = new ec2.Instance(this, "SubgraphHost", {
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
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    const eip = new ec2.CfnEIP(this, "SubgraphEip", {
      domain: "vpc",
      tags: [{ key: "Name", value: "hedera-subgraph" }],
    });
    new ec2.CfnEIPAssociation(this, "SubgraphEipAssoc", {
      allocationId: eip.attrAllocationId,
      instanceId: this.instance.instanceId,
    });

    new cdk.CfnOutput(this, "ElasticIp", { value: eip.ref });
    new cdk.CfnOutput(this, "InstanceId", { value: this.instance.instanceId });
    new cdk.CfnOutput(this, "GraphqlUrl", {
      value: `http://${eip.ref}:8000/subgraphs/name/MyToken`,
    });
    new cdk.CfnOutput(this, "SsmStartSessionCommand", {
      value: `aws ssm start-session --target ${this.instance.instanceId} --region ${this.region}`,
    });
  }
}
