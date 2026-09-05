import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { GraphNodeStack, SUBGRAPH_NAME } from "../lib/graph-node-stack.js";

type SynthProps = {
  allowedSshCidr?: string;
  allowedAdminCidr?: string;
  ebsGb?: number;
  instanceType?: string;
};

/** Concrete env makes Vpc.fromLookup return a dummy VPC, so no context file is needed. */
function synth(props: SynthProps = {}): Template {
  const app = new cdk.App();
  const stack = new GraphNodeStack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    instanceType: props.instanceType ?? "t3.medium",
    ebsGb: props.ebsGb ?? 30,
    hederaRpcUrl: "https://testnet.hashio.io/api",
    allowedSshCidr: props.allowedSshCidr,
    allowedAdminCidr: props.allowedAdminCidr,
  });
  return Template.fromStack(stack);
}

function ingressRules(
  t: Template,
): Array<{ FromPort?: number; CidrIp?: string }> {
  const sgs = t.findResources("AWS::EC2::SecurityGroup");
  return Object.values(sgs).flatMap(
    (r) =>
      (r.Properties?.SecurityGroupIngress ?? []) as Array<{
        FromPort?: number;
        CidrIp?: string;
      }>,
  );
}

function userDataScript(t: Template): string {
  const json = JSON.stringify(t.toJSON());
  // the UserData is a Fn::Base64 of Fn::Join pieces; searching the serialized template is enough
  return json;
}

describe("GraphNodeStack networking", () => {
  it("should open only the GraphQL port 8000 to the world by default", () => {
    const rules = ingressRules(synth());
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ FromPort: 8000, CidrIp: "0.0.0.0/0" });
  });

  it("should keep admin ports closed unless allowedAdminCidr is set, then gate them to that CIDR", () => {
    const closed = ingressRules(synth());
    expect(closed.some((r) => r.FromPort === 8020 || r.FromPort === 5001)).toBe(
      false,
    );

    const t = synth({ allowedAdminCidr: "203.0.113.4/32" });
    for (const port of [8020, 5001, 8030]) {
      t.hasResourceProperties("AWS::EC2::SecurityGroup", {
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({
            CidrIp: "203.0.113.4/32",
            FromPort: port,
            ToPort: port,
            IpProtocol: "tcp",
          }),
        ]),
      });
    }
    // still no world-open admin port
    expect(
      ingressRules(t).some(
        (r) => r.FromPort !== 8000 && r.CidrIp === "0.0.0.0/0",
      ),
    ).toBe(false);
  });

  it("should refuse unrestricted or malformed admin / SSH CIDRs before creating any rule", () => {
    for (const bad of [
      "0.0.0.0/0",
      "10.0.0.0/8",
      "203.0.113.4",
      "999.0.0.1/32",
      "::/0",
    ]) {
      expect(() => synth({ allowedAdminCidr: bad }), bad).toThrow();
      expect(() => synth({ allowedSshCidr: bad }), bad).toThrow();
    }
    expect(() => synth({ allowedAdminCidr: "203.0.113.0/24" })).not.toThrow();
  });

  it("should produce exactly four ingress rules with admin + no SSH, none of them world-open except 8000", () => {
    const rules = ingressRules(synth({ allowedAdminCidr: "203.0.113.4/32" }));
    expect(rules.map((r) => r.FromPort).sort()).toEqual([
      5001, 8000, 8020, 8030,
    ]);
    expect(
      rules.filter((r) => r.CidrIp === "0.0.0.0/0").map((r) => r.FromPort),
    ).toEqual([8000]);
  });

  it("should open SSH only to the given CIDR when allowedSshCidr is set", () => {
    expect(ingressRules(synth()).some((r) => r.FromPort === 22)).toBe(false);
    const t = synth({ allowedSshCidr: "203.0.113.4/32" });
    t.hasResourceProperties("AWS::EC2::SecurityGroup", {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          CidrIp: "203.0.113.4/32",
          FromPort: 22,
          ToPort: 22,
        }),
      ]),
    });
  });
});

describe("GraphNodeStack compute", () => {
  it("should run the requested instance type with an encrypted gp3 root volume of the requested size", () => {
    const t = synth({ instanceType: "t3.large", ebsGb: 60 });
    t.hasResourceProperties("AWS::EC2::Instance", {
      InstanceType: "t3.large",
      BlockDeviceMappings: Match.arrayWith([
        Match.objectLike({
          DeviceName: "/dev/sda1",
          Ebs: Match.objectLike({
            VolumeSize: 60,
            VolumeType: "gp3",
            Encrypted: true,
            DeleteOnTermination: true,
          }),
        }),
      ]),
    });
  });

  it("should require IMDSv2 and grant exactly the SSM managed policy with no inline policies", () => {
    const t = synth();
    expect(JSON.stringify(t.toJSON())).toContain('"HttpTokens":"required"');
    const roles = Object.values(t.findResources("AWS::IAM::Role")) as Array<{
      Properties: { ManagedPolicyArns?: unknown[]; Policies?: unknown[] };
    }>;
    expect(roles).toHaveLength(1);
    const role = roles[0] as {
      Properties: { ManagedPolicyArns?: unknown[]; Policies?: unknown[] };
    };
    expect(role.Properties.ManagedPolicyArns).toHaveLength(1);
    expect(JSON.stringify(role.Properties.ManagedPolicyArns)).toContain(
      "AmazonSSMManagedInstanceCore",
    );
    expect(role.Properties.Policies).toBeUndefined();
    t.resourceCountIs("AWS::IAM::Policy", 0);
  });

  it("should attach one Elastic IP and expose the GraphQL / admin / IPFS / SSM outputs", () => {
    const t = synth();
    t.resourceCountIs("AWS::EC2::EIP", 1);
    t.resourceCountIs("AWS::EC2::EIPAssociation", 1);
    const outputs = t.toJSON().Outputs as Record<string, unknown>;
    for (const key of [
      "ElasticIp",
      "InstanceId",
      "GraphqlUrl",
      "GraphNodeAdminUrl",
      "IpfsUrl",
      "SsmStartSessionCommand",
    ]) {
      expect(outputs, key).toHaveProperty(key);
    }
    expect(JSON.stringify(outputs.GraphqlUrl)).toContain(
      `/subgraphs/name/${SUBGRAPH_NAME}`,
    );
  });

  it("should embed the compose stack and the Hedera relay in user-data", () => {
    const script = userDataScript(synth());
    expect(script).toContain("graphprotocol/graph-node");
    expect(script).toContain("docker compose up -d");
    expect(script).toContain("HEDERA_RPC_URL=%s");
    expect(script).toContain("https://testnet.hashio.io/api");
    expect(script).toContain("testnet:${HEDERA_RPC_URL}");
  });

  it("should tag every resource as hackathon-only infrastructure", () => {
    const t = synth();
    t.hasResourceProperties("AWS::EC2::Instance", {
      Tags: Match.arrayWith([
        Match.objectLike({
          Key: "Lifecycle",
          Value: "hackathon-only-destroy-after-event",
        }),
      ]),
    });
  });

  it("should match the committed template snapshot", () => {
    const t = synth({ allowedAdminCidr: "203.0.113.4/32" });
    const template = t.toJSON() as {
      Resources: Record<string, { Type: string }>;
    };
    const resourceTypes = Object.values(template.Resources)
      .map((r) => r.Type)
      .sort();
    expect(resourceTypes).toMatchSnapshot();
  });
});
