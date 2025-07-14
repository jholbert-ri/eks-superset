import { KubectlV29Layer } from "@aws-cdk/lambda-layer-kubectl-v29";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as eks from "aws-cdk-lib/aws-eks";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

import { Construct } from "constructs";

/** Props: ID de la VPC existente */
export interface SupersetMinimalStackV2Props extends cdk.StackProps {
  existingVpcId: string;
}

export class SupersetMinimalStackV2 extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SupersetMinimalStackV2Props) {
    super(scope, id, props);

    /*────────── VPC ──────────*/
    const vpc = ec2.Vpc.fromLookup(this, "SupersetVpcV2", {
      vpcId: props.existingVpcId,
    });

    /*────────── EKS Cluster ──*/
    const cluster = new eks.Cluster(this, "SupersetClusterV2", {
      version: eks.KubernetesVersion.V1_29,
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacity: 2,
      defaultCapacityInstance: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MEDIUM
      ),
      kubectlLayer: new KubectlV29Layer(this, "KubectlLayerV2"),
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
    const ns = cluster.addManifest("SupersetNSV2", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: "superset-v2" },
    });

    /*────────── Secret BD (K8s) ─────────*/
    const pgPwd = new secretsmanager.Secret(this, "PgPasswordV2", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "superset" }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 24,
      },
    });

    const pwd = pgPwd.secretValueFromJson("password").unsafeUnwrap();

    const dbSecret = cluster.addManifest("SupersetDbSecretV2", {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "superset-db", namespace: "superset-v2" },
      type: "Opaque",
      stringData: {
        DB_USER: "superset",
        DB_PASSWORD: pwd,
        DB_PASS: pwd,
        DB_NAME: "superset",
        DB_HOST: "postgres",
        DB_PORT: "5432",
        SQLALCHEMY_DATABASE_URI: `postgresql+psycopg2://superset:${pwd}@postgres.superset-v2.svc.cluster.local:5432/superset`,
        SUPERSET_SECRET_KEY:
          "krG5BoMX+MzneoxDcWYXNQiV8bwuCQCLA+WwywWNDqkGoOiZL6QtaCAe",
        REDIS_HOST: "superset-redis-master",
        REDIS_PORT: "6379",
        REDIS_CACHE_DB: "1",
        REDIS_CELERY_DB: "0",
      },
    });

    dbSecret.node.addDependency(ns);

    /*────────── Postgres (StatefulSet + Svc) ─────*/
    const postgres = cluster.addManifest("PostgresV2", {
      apiVersion: "apps/v1",
      kind: "StatefulSet",
      metadata: { name: "postgres", namespace: "superset-v2" },
      spec: {
        serviceName: "postgres",
        replicas: 1,
        selector: { matchLabels: { app: "postgres" } },
        template: {
          metadata: { labels: { app: "postgres" } },
          spec: {
            containers: [
              {
                name: "postgres",
                image: "postgres:15-alpine",
                ports: [{ containerPort: 5432 }],
                env: [
                  {
                    name: "POSTGRES_USER",
                    valueFrom: {
                      secretKeyRef: {
                        name: "superset-db",
                        key: "DB_USER",
                      },
                    },
                  },
                  {
                    name: "POSTGRES_PASSWORD",
                    valueFrom: {
                      secretKeyRef: {
                        name: "superset-db",
                        key: "DB_PASSWORD",
                      },
                    },
                  },
                  {
                    name: "POSTGRES_DB",
                    valueFrom: {
                      secretKeyRef: {
                        name: "superset-db",
                        key: "DB_NAME",
                      },
                    },
                  },
                ],
                volumeMounts: [
                  { name: "pgdata", mountPath: "/var/lib/postgresql/data" },
                ],
              },
            ],
            volumes: [{ name: "pgdata", emptyDir: {} }],
          },
        },
      },
    });

    postgres.node.addDependency(dbSecret);

    cluster
      .addManifest("PostgresSvcV2", {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: "postgres", namespace: "superset-v2" },
        spec: {
          type: "ClusterIP",
          selector: { app: "postgres" },
          ports: [{ port: 5432, targetPort: 5432 }],
        },
      })
      .node.addDependency(postgres);

    /*────────── Output del Endpoint PostgreSQL ───*/
    new cdk.CfnOutput(this, "PostgresServiceV2", {
      value: "postgres.superset-v2.svc.cluster.local:5432",
      description: "DNS interno de Postgres para el chart de Superset V2",
    });
  }
} 