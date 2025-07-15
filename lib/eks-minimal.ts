import { KubectlV29Layer } from "@aws-cdk/lambda-layer-kubectl-v29";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as eks from "aws-cdk-lib/aws-eks";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
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

    /*────────── Application Load Balancer para Superset ────*/
    // Security Group para el ALB
    const albSecurityGroup = new ec2.SecurityGroup(
      this,
      "SupersetALBSecurityGroup",
      {
        vpc,
        description: "Security group for Superset ALB",
        allowAllOutbound: true,
      }
    );

    // Permitir tráfico HTTP y HTTPS desde internet
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP access from internet"
    );

    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow HTTPS access from internet"
    );

    // Permitir tráfico desde ALB hacia el cluster EKS
    cluster.clusterSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(8088),
      "Allow ALB to access Superset pods"
    );

    // Crear el Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, "SupersetALB", {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // Target Group para los pods de Superset
    const targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "SupersetTargetGroup",
      {
        port: 8088,
        protocol: elbv2.ApplicationProtocol.HTTP,
        vpc,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          enabled: true,
          path: "/health",
          protocol: elbv2.Protocol.HTTP,
          port: "8088",
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      }
    );

    // Listener HTTP (con redirección a HTTPS opcional)
    const httpListener = alb.addListener("SupersetHTTPListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.forward([targetGroup]),
    });

    // Configurar AWS Load Balancer Controller para vincular el Target Group
    const albControllerServiceAccount = cluster.addServiceAccount(
      "aws-load-balancer-controller",
      {
        name: "aws-load-balancer-controller",
        namespace: "kube-system",
      }
    );

    // Agregar política IAM al service account
    albControllerServiceAccount.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "iam:CreateServiceLinkedRole",
          "ec2:DescribeAccountAttributes",
          "ec2:DescribeAddresses",
          "ec2:DescribeAvailabilityZones",
          "ec2:DescribeInternetGateways",
          "ec2:DescribeVpcs",
          "ec2:DescribeSubnets",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeInstances",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DescribeTags",
          "ec2:GetCoipPoolUsage",
          "ec2:GetCoipPoolUsage",
          "ec2:DescribeCoipPools",
          "elasticloadbalancing:DescribeLoadBalancers",
          "elasticloadbalancing:DescribeLoadBalancerAttributes",
          "elasticloadbalancing:DescribeListeners",
          "elasticloadbalancing:DescribeListenerCertificates",
          "elasticloadbalancing:DescribeSSLPolicies",
          "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DescribeTargetGroupAttributes",
          "elasticloadbalancing:DescribeTargetHealth",
          "elasticloadbalancing:DescribeTags",
          "elasticloadbalancing:CreateLoadBalancer",
          "elasticloadbalancing:CreateTargetGroup",
          "elasticloadbalancing:CreateListener",
          "elasticloadbalancing:DeleteListener",
          "elasticloadbalancing:CreateRule",
          "elasticloadbalancing:DeleteRule",
          "elasticloadbalancing:AddTags",
          "elasticloadbalancing:RemoveTags",
          "elasticloadbalancing:ModifyLoadBalancerAttributes",
          "elasticloadbalancing:ModifyTargetGroup",
          "elasticloadbalancing:ModifyTargetGroupAttributes",
          "elasticloadbalancing:ModifyListener",
          "elasticloadbalancing:ModifyRule",
          "elasticloadbalancing:RegisterTargets",
          "elasticloadbalancing:DeregisterTargets",
          "elasticloadbalancing:SetWebAcl",
          "elasticloadbalancing:SetSecurityGroups",
          "elasticloadbalancing:SetSubnets",
          "elasticloadbalancing:DeleteLoadBalancer",
          "elasticloadbalancing:DeleteTargetGroup",
          "elasticloadbalancing:SetIpAddressType",
          "elbv2:DescribeLoadBalancers",
          "elbv2:DescribeLoadBalancerAttributes",
          "elbv2:DescribeListeners",
          "elbv2:DescribeListenerCertificates",
          "elbv2:DescribeSSLPolicies",
          "elbv2:DescribeRules",
          "elbv2:DescribeTargetGroups",
          "elbv2:DescribeTargetGroupAttributes",
          "elbv2:DescribeTargetHealth",
          "elbv2:DescribeTags",
          "elbv2:CreateLoadBalancer",
          "elbv2:CreateTargetGroup",
          "elbv2:CreateListener",
          "elbv2:DeleteListener",
          "elbv2:CreateRule",
          "elbv2:DeleteRule",
          "elbv2:AddTags",
          "elbv2:RemoveTags",
          "elbv2:ModifyLoadBalancerAttributes",
          "elbv2:ModifyTargetGroup",
          "elbv2:ModifyTargetGroupAttributes",
          "elbv2:ModifyListener",
          "elbv2:ModifyRule",
          "elbv2:RegisterTargets",
          "elbv2:DeregisterTargets",
          "elbv2:SetWebAcl",
          "elbv2:SetSecurityGroups",
          "elbv2:SetSubnets",
          "elbv2:DeleteLoadBalancer",
          "elbv2:DeleteTargetGroup",
          "elbv2:SetIpAddressType",
        ],
        resources: ["*"],
      })
    );

    // TargetGroupBinding para conectar el servicio Kubernetes con el Target Group de CDK
    const targetGroupBinding = cluster.addManifest(
      "SupersetTargetGroupBinding",
      {
        apiVersion: "elbv2.k8s.aws/v1beta1",
        kind: "TargetGroupBinding",
        metadata: {
          name: "superset-target-group-binding",
          namespace: "superset",
        },
        spec: {
          serviceRef: {
            name: "superset",
            port: 8088,
          },
          targetGroupARN: targetGroup.targetGroupArn,
        },
      }
    );

    // Asegurar que el binding se crea después del namespace
    targetGroupBinding.node.addDependency(ns);

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

    new cdk.CfnOutput(this, "SupersetALBDNS", {
      value: alb.loadBalancerDnsName,
      description: "DNS name del Application Load Balancer para Superset",
    });

    new cdk.CfnOutput(this, "SupersetURL", {
      value: `http://${alb.loadBalancerDnsName}`,
      description: "URL pública para acceder a Superset",
    });

    new cdk.CfnOutput(this, "SupersetTargetGroupArn", {
      value: targetGroup.targetGroupArn,
      description: "ARN del Target Group para configurar el TargetGroupBinding",
    });

    new cdk.CfnOutput(this, "ALBSecurityGroupId", {
      value: albSecurityGroup.securityGroupId,
      description: "ID del Security Group del ALB",
    });
  }
}
