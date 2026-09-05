import { describe, expect, it } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { HederaSubgraphStack } from "../lib/hedera-subgraph-stack.js";

/** テスト用にスタックを合成して Template を返す。
 *  env を具体値にすることで Vpc.fromLookup がダミー VPC を返し、context ファイル不要で動く。 */
function synth(props: { allowedSshCidr?: string } = {}) {
  const app = new cdk.App();
  const stack = new HederaSubgraphStack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    repoUrl: "https://github.com/example/repo.git",
    repoBranch: "main",
    instanceType: "t3.medium",
    allowedSshCidr: props.allowedSshCidr,
  });
  return Template.fromStack(stack);
}

/** Instance か LaunchTemplate のどちらに MetadataOptions が乗っても拾えるようにする */
function hasImdsv2Required(t: Template): boolean {
  const json = JSON.stringify(t.toJSON());
  return json.includes('"HttpTokens":"required"');
}

describe("HederaSubgraphStack networking & compute", () => {
  it("opens only port 8000 to the world by default", () => {
    const t = synth();
    t.hasResourceProperties("AWS::EC2::SecurityGroup", {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          CidrIp: "0.0.0.0/0",
          FromPort: 8000,
          ToPort: 8000,
          IpProtocol: "tcp",
        }),
      ]),
    });
  });

  it("does NOT open port 22 unless allowedSshCidr is set", () => {
    const t = synth();
    const sgs = t.findResources("AWS::EC2::SecurityGroup");
    const ingress = Object.values(sgs).flatMap(
      (r) => r.Properties?.SecurityGroupIngress ?? [],
    );
    expect(ingress.some((i: { FromPort?: number }) => i.FromPort === 22)).toBe(
      false,
    );
  });

  it("opens port 22 to the given CIDR when allowedSshCidr is set", () => {
    const t = synth({ allowedSshCidr: "203.0.113.4/32" });
    t.hasResourceProperties("AWS::EC2::SecurityGroup", {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ CidrIp: "203.0.113.4/32", FromPort: 22, ToPort: 22 }),
      ]),
    });
  });

  it("runs a t3.medium with a 30GB gp3 root volume", () => {
    const t = synth();
    t.hasResourceProperties("AWS::EC2::Instance", {
      InstanceType: "t3.medium",
      BlockDeviceMappings: Match.arrayWith([
        Match.objectLike({
          DeviceName: "/dev/sda1",
          Ebs: Match.objectLike({ VolumeSize: 30, VolumeType: "gp3" }),
        }),
      ]),
    });
  });

  it("requires IMDSv2", () => {
    expect(hasImdsv2Required(synth())).toBe(true);
  });

  it("attaches only AmazonSSMManagedInstanceCore to the instance role", () => {
    const t = synth();
    const roles = JSON.stringify(t.findResources("AWS::IAM::Role"));
    expect(roles).toContain("AmazonSSMManagedInstanceCore");
    expect(roles).not.toContain("AdministratorAccess");
    expect(roles).not.toContain("PowerUserAccess");
  });
});

describe("HederaSubgraphStack EIP & outputs", () => {
  it("allocates an Elastic IP and associates it with the instance", () => {
    const t = synth();
    t.resourceCountIs("AWS::EC2::EIP", 1);
    t.hasResourceProperties("AWS::EC2::EIPAssociation", {
      InstanceId: Match.anyValue(),
    });
  });

  it("exports the GraphQL URL and SSM command as outputs", () => {
    const t = synth();
    const keys = Object.keys(t.toJSON().Outputs ?? {});
    expect(keys).toEqual(
      expect.arrayContaining([
        "GraphqlUrl",
        "ElasticIp",
        "InstanceId",
        "SsmStartSessionCommand",
      ]),
    );
  });

  it("passes the bootstrap script call into instance user data", () => {
    const t = synth();
    t.hasResourceProperties("AWS::EC2::Instance", {
      UserData: Match.anyValue(),
    });
  });
});
