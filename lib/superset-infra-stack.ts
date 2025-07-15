import { KubectlV27Layer } from "@aws-cdk/lambda-layer-kubectl-v27";
import * as cdk from "aws-cdk-lib";
import { Duration, Stack } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as eks from "aws-cdk-lib/aws-eks";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs"; // ajusta el import
import { AwsVPC } from "./constants";
import { SupersetEksStackProps } from "./interfaces";

export class SupersetInfraStack extends Stack {
  public readonly cluster: eks.Cluster;
  public readonly database: rds.DatabaseInstance;
  public readonly dbSecret: secretsmanager.Secret;
  public readonly flaskSecret: secretsmanager.Secret;
  public readonly albControllerChart: eks.HelmChart;

  constructor(scope: Construct, id: string, props: SupersetEksStackProps) {
    super(scope, id, props);

    /*──────────────────── Tags ────────────────────*/
    cdk.Tags.of(this).add("Environment", props.environment);

    /*──────────────────── VPC ─────────────────────*/
    const vpc = ec2.Vpc.fromLookup(this, "ExistingVPC", { vpcId: AwsVPC.BETA });

    /*──────────────────── Secrets ─────────────────*/
    this.dbSecret = new secretsmanager.Secret(this, "SupersetDBSecret", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "superset" }),
        generateStringKey: "password",
        excludeCharacters: '"@/\\',
        passwordLength: 32,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.flaskSecret = new secretsmanager.Secret(this, "SupersetFlaskSecret", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "SECRET_KEY",
        passwordLength: 64,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    /*──────────────────── RDS ─────────────────────*/
    const dbSg = new ec2.SecurityGroup(this, "SupersetDBSG", {
      vpc,
      description: "SG for Superset RDS",
      allowAllOutbound: true,
    });

    this.database = new rds.DatabaseInstance(this, "SupersetDatabase", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.SMALL
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSg],
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      databaseName: "superset",
      backupRetention: Duration.days(7),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      storageEncrypted: true,
    });

    /*──────────────────── EKS ─────────────────────*/
    this.cluster = new eks.Cluster(this, "SupersetCluster", {
      version: eks.KubernetesVersion.V1_27,
      vpc,
      defaultCapacity: 0,
      kubectlLayer: new KubectlV27Layer(this, "KubectlLayer"),
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
    });

    /*─────── Agregar usuarios al aws-auth ConfigMap ────────*/
    // Agregar el rol de SSO DevOps para acceso kubectl
    this.cluster.awsAuth.addRoleMapping(
      iam.Role.fromRoleArn(
        this,
        "DevOpsSSORoleRef",
        "arn:aws:iam::730335418300:role/AWSReservedSSO_Devops_f26912c48bab8699"
      ),
      {
        groups: ["system:masters"],
        username: "devops-sso-user",
      }
    );

    // Agregar el usuario INFRA-BETA-USER también
    this.cluster.awsAuth.addUserMapping(
      iam.User.fromUserArn(
        this,
        "InfraBetaUserRef",
        "arn:aws:iam::730335418300:user/INFRA-BETA-USER"
      ),
      {
        groups: ["system:masters"],
        username: "infra-beta-user",
      }
    );

    /*─────── Fargate profiles & execution role ────*/
    const execRole = new iam.Role(this, "FargateExecutionRole", {
      assumedBy: new iam.ServicePrincipal("eks-fargate-pods.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonEKSFargatePodExecutionRolePolicy"
        ),
      ],
    });

    execRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: [this.dbSecret.secretArn, this.flaskSecret.secretArn],
      })
    );

    this.cluster.addFargateProfile("system", {
      selectors: [{ namespace: "kube-system" }],
      podExecutionRole: execRole,
    });

    this.cluster.addFargateProfile("superset", {
      selectors: [{ namespace: "superset" }],
      podExecutionRole: execRole,
    });

    dbSg.addIngressRule(
      ec2.Peer.securityGroupId(this.cluster.clusterSecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      "EKS to RDS"
    );

    /*──────── AWS Load Balancer Controller ───────*/
    const albSA = this.cluster.addServiceAccount("alb-sa", {
      name: "aws-load-balancer-controller",
      namespace: "kube-system",
    });

    albSA.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: ["*"],
        actions: [
          "elasticloadbalancing:*",
          "ec2:Describe*",
          "iam:CreateServiceLinkedRole",
        ],
      })
    );

    this.albControllerChart = this.cluster.addHelmChart("ALBController", {
      chart: "aws-load-balancer-controller",
      repository: "https://aws.github.io/eks-charts",
      namespace: "kube-system",
      release: "aws-load-balancer-controller",
      values: {
        clusterName: this.cluster.clusterName,
        serviceAccount: { create: false, name: albSA.serviceAccountName },
        region: this.region,
        vpcId: vpc.vpcId,
      },
    });

    /*────────── Namespace + Secret ───────────────*/
    const ns = this.cluster.addManifest("SupersetNS", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: "superset" },
    });

    // Crear secret simple para testing
    this.cluster
      .addManifest("SupersetDBUriSecret", {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "superset-db-uri", namespace: "superset" },
        type: "Opaque",
        stringData: {
          DB_HOST: this.database.instanceEndpoint.hostname,
          DB_PORT: "5432",
          DB_NAME: "superset",
          DB_USER: "superset",
        },
      })
      .node.addDependency(ns);

    /*────────── Export outputs para AppStack ─────*/
    new cdk.CfnOutput(this, "SupersetClusterName", {
      value: this.cluster.clusterName,
      exportName: "SupersetClusterName",
    });

    new cdk.CfnOutput(this, "SupersetKubectlRoleArn", {
      value: this.cluster.kubectlRole!.roleArn,
      exportName: "SupersetKubectlRoleArn",
    });

    new cdk.CfnOutput(this, "SupersetClusterSG", {
      value: this.cluster.clusterSecurityGroupId,
      exportName: "SupersetClusterSG",
    });

    new cdk.CfnOutput(this, "SupersetDBSecretArn", {
      value: this.dbSecret.secretArn,
      exportName: "SupersetDBSecretArn",
    });

    new cdk.CfnOutput(this, "SupersetFlaskSecretArn", {
      value: this.flaskSecret.secretArn,
      exportName: "SupersetFlaskSecretArn",
    });

    new cdk.CfnOutput(this, "SupersetDBHost", {
      value: this.database.instanceEndpoint.hostname,
      exportName: "SupersetDBHost",
    });

    /*────────── Test Manifest ─────*/
    const testManifest = this.cluster.addManifest("TestManifest", {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "test-config",
        namespace: "default",
      },
      data: {
        "test.txt": "This is a test from InfraStack",
      },
    });
  }
}
