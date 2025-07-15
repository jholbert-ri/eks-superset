import { KubectlV29Layer } from "@aws-cdk/lambda-layer-kubectl-v29";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as eks from "aws-cdk-lib/aws-eks";
import * as iam from "aws-cdk-lib/aws-iam";

import { Construct } from "constructs";

/** Props: ID de la VPC existente */
export interface SupersetMinimalStackProps extends cdk.StackProps {
  existingVpcId: string;
}

export class SupersetMinimalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SupersetMinimalStackProps) {
    super(scope, id, props);

    /*────────── VPC ──────────*/
    const vpc = ec2.Vpc.fromLookup(this, "SupersetVpc", {
      vpcId: props.existingVpcId,
    });

    /*────────── EKS Cluster ──*/
    const cluster = new eks.Cluster(this, "SupersetCluster", {
      version: eks.KubernetesVersion.V1_29,
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacity: 2,
      defaultCapacityInstance: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MEDIUM
      ),
      kubectlLayer: new KubectlV29Layer(this, "KubectlLayer"),
      endpointAccess: eks.EndpointAccess.PUBLIC,
    });

    /*── Mapear rol Devops al grupo system:masters ──*/
    cluster.awsAuth.addRoleMapping(
      iam.Role.fromRoleArn(
        this,
        "DevopsSSORole",
        "arn:aws:iam::730335418300:role/AWSReservedSSO_Devops_f26912c48bab8699"
      ),
      {
        username: "devops",
        groups: ["system:masters"],
      }
    );

    /*────────── Namespace ────*/
    const ns = cluster.addManifest("SupersetNS", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: "superset" },
    });

    /*────────── Output del Cluster ───*/
    new cdk.CfnOutput(this, "ClusterName", {
      value: cluster.clusterName,
      description: "Nombre del cluster EKS para configurar kubectl",
    });

    new cdk.CfnOutput(this, "ClusterEndpoint", {
      value: cluster.clusterEndpoint,
      description: "Endpoint del cluster EKS",
    });

    new cdk.CfnOutput(this, "ClusterSecurityGroupId", {
      value: cluster.clusterSecurityGroup.securityGroupId,
      description: "ID del Security Group del cluster EKS",
    });

    new cdk.CfnOutput(this, "ClusterRoleArn", {
      value: cluster.role.roleArn,
      description: "ARN del rol IAM del cluster EKS",
    });

    new cdk.CfnOutput(this, "NamespaceName", {
      value: "superset",
      description: "Nombre del namespace de Superset",
    });

    new cdk.CfnOutput(this, "VpcId", {
      value: vpc.vpcId,
      description: "ID de la VPC donde se desplegó el cluster",
    });
  }
}
