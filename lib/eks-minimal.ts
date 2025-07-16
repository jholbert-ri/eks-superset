import { KubectlV29Layer } from "@aws-cdk/lambda-layer-kubectl-v29";
import * as cdk from "aws-cdk-lib";
import { Fn } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as eks from "aws-cdk-lib/aws-eks";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface SupersetMinimalStackProps extends cdk.StackProps {
  existingVpcId: string;
  existingClusterName?: string; // si ya existe
}

export class SupersetMinimalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SupersetMinimalStackProps) {
    super(scope, id, props);

    /*────────── VPC ──────────*/
    const vpc = ec2.Vpc.fromLookup(this, "SupersetVpc", {
      vpcId: props.existingVpcId,
    });

    let cluster: eks.ICluster;
    let isNewCluster = false;
    let clusterRoleArn = "n/a";

    /*────────── EKS ──────────*/
    if (props.existingClusterName) {
      /* Importar clúster existente - versión simplificada */
      const stackInfo = cdk.Stack.of(this);

      // Security Group del cluster existente
      const clusterSg = ec2.SecurityGroup.fromSecurityGroupId(
        this,
        "SupersetClusterControlPlaneSecurityGroup54CF4865",
        "sg-0bb0c7b8872905f0e"
      );

      // Importar cluster sin kubectl para evitar problemas de permisos
      cluster = eks.Cluster.fromClusterAttributes(this, "ImportedCluster", {
        clusterName: "SupersetClusterB38A40B0-4c56592879f746fcb953cd4907ba80af",
        vpc,
        clusterSecurityGroupId: clusterSg.securityGroupId,
        clusterEndpoint: "https://7777821055B35B97391AB6300C88A2B0.gr7.sa-east-1.eks.amazonaws.com",
        clusterCertificateAuthorityData: "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSURCVENDQWUyZ0F3SUJBZ0lJTXJWRXZDcTFROUl3RFFZSktvWklodmNOQVFFTEJRQXdGVEVUTUJFR0ExVUUKQXhNS2EzVmlaWEp1WlhSbGN6QWVGdzB5TlRBM01UVXhORFExTWpCYUZ3MHpOVEEzTVRNeE5EVXdNakJhTUJVeApFekFSQmdOVkJBTVRDbXQxWW1HeWJtVjBaWE13Z2dFaU1BMEdDU3FHU0liM0RRRUJBUVVBQTRJQkR3QXdnZ0VLCkFvSUJBUURGbFhaQW5yMDB4QUlMR0Z2bnhISGlqNk5rS01KUXk1THZwVjFFWTZORGpzOU9WWSszYTFyckg0b1QKZFN5K1RTcjJWN0svY25MdEpLbW9EcU8wbVFoQU9sZ1FDakZ6QWVydHhIaC9iNFU0SFhld1FxWFV6SmxEZjA4YgpnbmN5RnFETkJJSkI4OTd0clI3UXZjUVYzdDhUUDQ2b2VIWURqb0lmS3k5RG1pc3Z6bEo3OHhHSHY5a0lkbnJkCng4dnIzSlh3L1IreXAxb1BJMWxRTTRMcGF5VVFHTnB2emtPalpxZzlIUTA2VHlmaXRHMUROdUhOQzcwNkhrVGEKU1p6QkV0VXVlYW56YjN5d0VINXhsNzlMWWo4VklaejhZdWhOdnhIWGdsa2pTckFtOVZzamJYdjVJMlZZMmg3UwpMZjRENUpldGRuOXdsU3BodzQzbE9ZeHJCTUdWQWdNQkFBR2pXVEJYTUE0R0ExVWREd0VCL3dRRUF3SUNwREFQCkJnTlZIUk1CQWY4RUJUQURBUUgvTUIwR0ExVWREZ1FXQkJSN21ieFR6b0JyVjFNRTVoeVo2QlNaK1pRM2xEQVYKQmdOVkhSRUVEakFNZ2dwcmRXSmxjbTVsZEdWek1BMEdDU3FHU0liM0RRRUJDd1VBQTRJQkFRQldiSDVZOUR6VQpzNWVvQnNyRmh2eTVBcW5UZVFIOHFQNTJabTMyWWlmR0R0RVpHT2EvVTlpRGdLYjB5SzlDcDFYNE5NdXlEK1IyCjJzWmsrcXBzVTc0aHhHRlY5Wkd5THBuU3NHS0JydkdhL05id1RNQ1RNUEpiTGxOTE1Jei9ZTDFFQk1tQmxMa2wKdk93N2J0Z2lvbjdyQXYvVEhDUkNuSWRjMCtmOFJrYnhWcUlGa1Y2U2RQd0lxVEY3MVpObDFpU2diM0NvRXhpUgpTdG1qVEJpU0EvWU1mV1FVZkZ6Y0lORW51TXZub09MQzhrK1ZSNjR4TS8vZXBwTGEzSUxwcXNlc1ovY0ZNandVCjdRa0dXOW1tY1JsRjV1TWpsaVpUYVNYQ0xLMTVZRVU3Y3o2SDlWaXc4eW5oZDhrT3dGbEdoV2d5WVA1aHBNb3AKeWNYYkxqVU1UaFJ1Ci0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0K"
      });

      clusterRoleArn = "arn:aws:iam::730335418300:role/SupersetMinimalStack-SupersetClusterRole06F42B19-icTsPrdPsAaK";
    } else {
      /* Crear clúster nuevo */
      const newCluster = new eks.Cluster(this, "SupersetCluster", {
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

      cluster = newCluster;
      isNewCluster = true;
      clusterRoleArn = newCluster.role.roleArn;

      /* Exportar para futuros imports */
      new cdk.CfnOutput(this, "ClusterEndpointExport", {
        value: newCluster.clusterEndpoint,
        exportName: `${newCluster.clusterName}-endpoint`,
      });
      new cdk.CfnOutput(this, "ClusterCertExport", {
        value: newCluster.clusterCertificateAuthorityData ?? "",
        exportName: `${newCluster.clusterName}-cert`,
      });
      new cdk.CfnOutput(this, "ClusterSGExport", {
        value: newCluster.clusterSecurityGroup.securityGroupId,
        exportName: `${newCluster.clusterName}-sg`,
      });
    }

    /*────────── (Opcional) mapear tu rol DevOps solo en clúster nuevo ──────────*/
    if (isNewCluster && "awsAuth" in cluster) {
      (cluster as eks.Cluster).awsAuth.addRoleMapping(
        iam.Role.fromRoleArn(
          this,
          "DevopsSSORole",
          "arn:aws:iam::730335418300:role/AWSReservedSSO_Devops_f26912c48bab8699"
        ),
        { username: "devops", groups: ["system:masters"] }
      );
    }

    /*────────── Namespace Superset ──────────*/
    // NOTA: Solo crear namespace si tenemos un cluster nuevo con kubectl
    let ns: any;
    if (isNewCluster) {
      ns = cluster.addManifest("SupersetNS", {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: "superset" },
      });
    }

    /*────────── ALB y SG ──────────*/
    const albSg = new ec2.SecurityGroup(this, "SupersetALBSG", {
      vpc,
      allowAllOutbound: true,
      description: "SG for Superset ALB",
    });

    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP");
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    cluster.clusterSecurityGroup.addIngressRule(
      albSg,
      ec2.Port.tcp(8088),
      "ALB to Superset pods"
    );

    const alb = new elbv2.ApplicationLoadBalancer(this, "SupersetALB", {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const tg = new elbv2.ApplicationTargetGroup(this, "SupersetTG", {
      vpc,
      port: 8088,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { path: "/health", port: "8088" },
    });

    alb.addListener("SupersetHTTP", {
      port: 80,
      defaultAction: elbv2.ListenerAction.forward([tg]),
    });

    /*────────── TargetGroupBinding (lo consumirá tu controller Helm) ──────────*/
    // NOTA: Solo crear TGB si tenemos un cluster nuevo con kubectl
    if (isNewCluster && ns) {
      const tgb = cluster.addManifest("SupersetTGB", {
        apiVersion: "elbv2.k8s.aws/v1beta1",
        kind: "TargetGroupBinding",
        metadata: { name: "superset-tgb", namespace: "superset" },
        spec: {
          serviceRef: { name: "superset", port: 8088 },
          targetGroupARN: tg.targetGroupArn,
        },
      });
      tgb.node.addDependency(ns);
    }

    /*────────── Salidas ──────────*/
    new cdk.CfnOutput(this, "SupersetURL", {
      value: `http://${alb.loadBalancerDnsName}`,
      description: "URL pública de Superset",
    });
    new cdk.CfnOutput(this, "ClusterRoleArn", { value: clusterRoleArn });
  }
}
