import { KubectlV29Layer } from "@aws-cdk/lambda-layer-kubectl-v29";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as eks from "aws-cdk-lib/aws-eks";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

/** Props opcionales: vpcId de la VPC existente */
export interface SupersetMinimalStackProps extends cdk.StackProps {
  /** ID (vpc-xxxxxxxx) o nombre de la VPC que ya tienes creada */
  existingVpcId: string;
}

export class SupersetMinimalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SupersetMinimalStackProps) {
    super(scope, id, props);

    /*─────────────────────── VPC ───────────────────────*/
    const vpc = ec2.Vpc.fromLookup(this, "SupersetVpc", {
      vpcId: props.existingVpcId, // <-- IMPORTADA, no se crea nada nuevo
    });

    /*─────────────────────── EKS ───────────────────────*/
    const cluster = new eks.Cluster(this, "SupersetCluster", {
      version: eks.KubernetesVersion.V1_29,
      vpc,
      defaultCapacity: 2,
      defaultCapacityInstance: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MEDIUM
      ),
      outputClusterName: true,
      kubectlLayer: new KubectlV29Layer(this, "KubectlLayer"), // 👈 requerido
    });

    /*────────────────── Namespace & Secrets ─────────────*/
    const ns = cluster.addManifest("NS", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: "superset" },
    });

    const pgPwd = new secretsmanager.Secret(this, "PgPassword", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "superset" }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 24,
      },
    });

    const k8sDbSecret = cluster.addManifest("K8sDbSecret", {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "superset-db", namespace: "superset" },
      type: "Opaque",
      stringData: {
        DB_USER: "superset",
        DB_PASSWORD: pgPwd.secretValueFromJson("password").unsafeUnwrap(),
        DB_NAME: "superset",
        DB_HOST: "postgres",
        DB_PORT: "5432",
      },
    });
    k8sDbSecret.node.addDependency(ns);

    /*──────────────────── Postgres ─────────────────────*/
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
                envFrom: [{ secretRef: { name: "superset-db" } }],
                env: [
                  { name: "POSTGRES_USER", value: "superset" },
                  {
                    name: "POSTGRES_PASSWORD",
                    valueFrom: {
                      secretKeyRef: { name: "superset-db", key: "DB_PASSWORD" },
                    },
                  },
                  { name: "POSTGRES_DB", value: "superset" },
                ],
                volumeMounts: [
                  { name: "pgdata", mountPath: "/var/lib/postgresql/data" },
                ],
              },
            ],
            volumes: [
              { name: "pgdata", emptyDir: {} }, // solo pruebas
            ],
          },
        },
      },
    });

    const pgSvc = cluster.addManifest("PostgresSvc", {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "postgres", namespace: "superset" },
      spec: {
        type: "ClusterIP",
        selector: { app: "postgres" },
        ports: [{ port: 5432, targetPort: 5432 }],
      },
    });
    pgSvc.node.addDependency(postgres);

    /*────────────────── Superset config & Job ───────────*/
    const supersetCfg = cluster.addManifest("SupersetConfigMap", {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "superset-config", namespace: "superset" },
      data: {
        "superset_config.py": `
from flask_appbuilder.security.manager import AUTH_DB
SECRET_KEY = 'changeme'
SQLALCHEMY_DATABASE_URI = ''
AUTH_TYPE = AUTH_DB
ENABLE_PROXY_FIX = True
`,
      },
    });

    const initJob = cluster.addManifest("SupersetInit", {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "superset-init", namespace: "superset" },
      spec: {
        template: {
          spec: {
            restartPolicy: "OnFailure",
            containers: [
              {
                name: "init",
                image: "apache/superset:4.0.0",
                command: ["sh", "-c"],
                args: [
                  `
export DB_PASS=$(cat /run/secrets/DB_PASSWORD);
export SQLALCHEMY_DATABASE_URI=postgresql://superset:${"$"}{DB_PASS}@postgres:5432/superset;
superset db upgrade &&
superset init &&
superset fab create-admin --username admin --password admin123 --firstname Admin --lastname User --email admin@example.com
`,
                ],
                envFrom: [{ secretRef: { name: "superset-db" } }],
                env: [
                  {
                    name: "SUPERSET_CONFIG_PATH",
                    value: "/app/pythonpath/superset_config.py",
                  },
                ],
                volumeMounts: [
                  { name: "superset-config", mountPath: "/app/pythonpath" },
                  {
                    name: "db-secret",
                    mountPath: "/run/secrets",
                    readOnly: true,
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "superset-config",
                configMap: { name: "superset-config" },
              },
              { name: "db-secret", secret: { secretName: "superset-db" } },
            ],
          },
        },
      },
    });
    initJob.node.addDependency(supersetCfg);

    /*───────────────── Superset Deployment ──────────────*/
    const supersetDep = cluster.addManifest("SupersetDep", {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "superset", namespace: "superset" },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "superset" } },
        template: {
          metadata: { labels: { app: "superset" } },
          spec: {
            containers: [
              {
                name: "superset",
                image: "apache/superset:4.0.0",
                ports: [{ containerPort: 8088 }],
                envFrom: [{ secretRef: { name: "superset-db" } }],
                env: [
                  {
                    name: "SQLALCHEMY_DATABASE_URI",
                    value:
                      "postgresql://superset:$(DB_PASSWORD)@postgres:5432/superset",
                  },
                  {
                    name: "SUPERSET_CONFIG_PATH",
                    value: "/app/pythonpath/superset_config.py",
                  },
                ],
                volumeMounts: [
                  { name: "superset-config", mountPath: "/app/pythonpath" },
                ],
                readinessProbe: {
                  httpGet: { path: "/health", port: 8088 },
                  initialDelaySeconds: 30,
                  periodSeconds: 10,
                },
              },
            ],
            volumes: [
              {
                name: "superset-config",
                configMap: { name: "superset-config" },
              },
            ],
          },
        },
      },
    });
    supersetDep.node.addDependency(initJob);

    const supersetSvc = cluster.addManifest("SupersetSvc", {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: "superset",
        namespace: "superset",
        annotations: {
          "service.beta.kubernetes.io/aws-load-balancer-type": "nlb",
        },
      },
      spec: {
        type: "LoadBalancer",
        selector: { app: "superset" },
        ports: [{ port: 80, targetPort: 8088 }],
      },
    });
    supersetSvc.node.addDependency(supersetDep);

    /*────────── Outputs útiles ──────────*/
    new cdk.CfnOutput(this, "SupersetURLCommand", {
      value:
        "kubectl get svc -n superset superset -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'",
      description: "Comando para obtener la URL pública de Superset",
    });
  }
}
