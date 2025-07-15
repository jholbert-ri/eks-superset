import { KubectlV29Layer } from "@aws-cdk/lambda-layer-kubectl-v29";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as eks from "aws-cdk-lib/aws-eks";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

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

    /*────────── Secret BD (K8s) ─────────*/
    const pgPwd = new secretsmanager.Secret(this, "PgPassword", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "superset" }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 24,
      },
    });

    // Secreto principal para la base de datos
    const dbSecret = cluster.addManifest("SupersetDbSecret", {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "superset-db", namespace: "superset" },
      type: "Opaque",
      stringData: {
        DB_USER: "superset",
        DB_PASSWORD: pgPwd.secretValueFromJson("password").unsafeUnwrap(),
        DB_NAME: "superset",
        DB_HOST: "postgres.superset.svc.cluster.local",
        DB_PORT: "5432",
      },
    });
    dbSecret.node.addDependency(ns);

    // Secreto para Superset con la SECRET_KEY y conexión de BD
    const supersetSecret = cluster.addManifest("SupersetSecret", {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "superset-env", namespace: "superset" },
      type: "Opaque",
      stringData: {
        SECRET_KEY: "superset-secret-key-change-me-in-production",
        SQLALCHEMY_DATABASE_URI: `postgresql://superset:${pgPwd.secretValueFromJson("password").unsafeUnwrap()}@postgres.superset.svc.cluster.local:5432/superset`,
      },
    });
    supersetSecret.node.addDependency(ns);

    /*────────── Postgres (StatefulSet + Svc) ─────*/
    const postgres = cluster.addManifest("Postgres", {
      apiVersion: "apps/v1",
      kind: "StatefulSet",
      metadata: { name: "postgres", namespace: "superset" },
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
                // CORRECCIÓN: Usar variables específicas en lugar de envFrom
                env: [
                  {
                    name: "POSTGRES_USER",
                    valueFrom: {
                      secretKeyRef: {
                        name: "superset-db",
                        key: "DB_USER"
                      }
                    }
                  },
                  {
                    name: "POSTGRES_PASSWORD",
                    valueFrom: {
                      secretKeyRef: {
                        name: "superset-db",
                        key: "DB_PASSWORD"
                      }
                    }
                  },
                  {
                    name: "POSTGRES_DB",
                    valueFrom: {
                      secretKeyRef: {
                        name: "superset-db",
                        key: "DB_NAME"
                      }
                    }
                  }
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
      .addManifest("PostgresSvc", {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: "postgres", namespace: "superset" },
        spec: {
          type: "ClusterIP",
          selector: { app: "postgres" },
          ports: [{ port: 5432, targetPort: 5432 }],
        },
      })
      .node.addDependency(postgres);

    /*────────── Output del Endpoint PostgreSQL ───*/
    new cdk.CfnOutput(this, "PostgresService", {
      value: "postgres.superset.svc.cluster.local:5432",
      description: "DNS interno de Postgres para el chart de Superset",
    });
  }
}
