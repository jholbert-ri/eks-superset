import * as cdk from "aws-cdk-lib";
import { Stack } from "aws-cdk-lib";
import * as eks from "aws-cdk-lib/aws-eks";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { SupersetEksStackProps } from "./interfaces";

export interface SupersetAppStackProps extends SupersetEksStackProps {
  cluster: eks.Cluster;
  database: rds.DatabaseInstance;
  dbSecret: secretsmanager.Secret;
  flaskSecret: secretsmanager.Secret;
  albControllerChart: eks.HelmChart;
  dbSecretArn: string;
  flaskSecretArn: string;
}

export class SupersetAppStack extends Stack {
  constructor(scope: Construct, id: string, props: SupersetAppStackProps) {
    super(scope, id, props);

    /*───────────────────────────── Etiquetado ─────────────────────────────*/
    cdk.Tags.of(this).add("Environment", props.environment);

    /*───────────────────────────── ConfigMap para Superset ────────────────*/
    const supersetConfig = props.cluster.addManifest("SupersetConfig", {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "superset-config",
        namespace: "superset",
      },
      data: {
        "superset_config.py": `
import os
from flask_appbuilder.security.manager import AUTH_DB

# Security
SECRET_KEY = '1Z9Fh5j6nBAzS6gQyLxqCUujWUvR3ifpakl/ZICshlgSp1LaffD0CDM+vBJ3UWnO'

# Database configuration
SQLALCHEMY_DATABASE_URI = os.getenv('SQLALCHEMY_DATABASE_URI')

# Redis configuration
REDIS_HOST = 'redis'
REDIS_PORT = 6379

# Cache configuration  
CACHE_CONFIG = {
    'CACHE_TYPE': 'RedisCache',
    'CACHE_DEFAULT_TIMEOUT': 300,
    'CACHE_KEY_PREFIX': 'superset_',
    'CACHE_REDIS_HOST': REDIS_HOST,
    'CACHE_REDIS_PORT': REDIS_PORT,
    'CACHE_REDIS_DB': 1,
}

# Auth configuration
AUTH_TYPE = AUTH_DB
AUTH_ROLE_ADMIN = 'Admin'
AUTH_ROLE_PUBLIC = 'Public'

# Enable proxy fix for load balancer
ENABLE_PROXY_FIX = True

# Logging
LOG_LEVEL = "INFO"
`,
      },
    });

    /*───────────────────────────── Simple Redis Deployment ──────────────────────────*/
    const redisDeployment = props.cluster.addManifest("RedisDeployment", {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: "redis",
        namespace: "superset",
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: "redis",
          },
        },
        template: {
          metadata: {
            labels: {
              app: "redis",
            },
          },
          spec: {
            containers: [
              {
                name: "redis",
                image: "redis:7-alpine",
                ports: [{ containerPort: 6379 }],
              },
            ],
          },
        },
      },
    });

    /*───────────────────────────── Superset Init Job ────────────────────────────*/
    const initJob = new eks.KubernetesManifest(this, "SupersetInitJob", {
      cluster: props.cluster,
      manifest: [
        {
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: {
            name: "superset-init",
            namespace: "superset",
          },
          spec: {
            template: {
              spec: {
                restartPolicy: "OnFailure",
                containers: [
                  {
                    name: "superset-init",
                    image: "apache/superset:4.0.0",
                    command: ["sh", "-c"],
                    args: [
                      "export SQLALCHEMY_DATABASE_URI=postgresql://superset:$DB_PASSWORD@$DB_HOST:5432/superset && superset db upgrade && superset init && superset fab create-admin --username admin --firstname Admin --lastname User --email admin@superset.com --password admin123",
                    ],
                    env: [
                      {
                        name: "DB_HOST",
                        value: props.database.instanceEndpoint.hostname,
                      },
                      {
                        name: "DB_PASSWORD",
                        value: "vO'b2?+bhyiD,quKc?s$6-QihQii{($x",
                      },
                      {
                        name: "SUPERSET_CONFIG_PATH",
                        value: "/etc/superset/superset_config.py",
                      },
                    ],
                    volumeMounts: [
                      {
                        name: "superset-config",
                        mountPath: "/etc/superset",
                      },
                    ],
                  },
                ],
                volumes: [
                  {
                    name: "superset-config",
                    configMap: {
                      name: "superset-config",
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    });

    /*───────────────────────────── Superset Deployment ────────────────────────────*/
    const supersetDeployment = new eks.KubernetesManifest(this, "SupersetDeployment", {
      cluster: props.cluster,
      manifest: [
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: "superset",
            namespace: "superset",
          },
          spec: {
            replicas: 1,
            selector: {
              matchLabels: {
                app: "superset",
              },
            },
            template: {
              metadata: {
                labels: {
                  app: "superset",
                },
              },
              spec: {
                containers: [
                  {
                    name: "superset",
                    image: "apache/superset:4.0.0",
                    ports: [{ containerPort: 8088 }],
                    command: ["sh", "-c"],
                    args: [
                      "export SQLALCHEMY_DATABASE_URI=postgresql://superset:$DB_PASSWORD@$DB_HOST:5432/superset && superset run -h 0.0.0.0 -p 8088",
                    ],
                    env: [
                      {
                        name: "DB_HOST",
                        value: props.database.instanceEndpoint.hostname,
                      },
                      {
                        name: "DB_PASSWORD",
                        value: "vO'b2?+bhyiD,quKc?s$6-QihQii{($x",
                      },
                      {
                        name: "SUPERSET_CONFIG_PATH",
                        value: "/etc/superset/superset_config.py",
                      },
                    ],
                    volumeMounts: [
                      {
                        name: "superset-config",
                        mountPath: "/etc/superset",
                      },
                    ],
                    readinessProbe: {
                      httpGet: {
                        path: "/health",
                        port: 8088,
                      },
                      initialDelaySeconds: 30,
                      periodSeconds: 10,
                    },
                  },
                ],
                volumes: [
                  {
                    name: "superset-config",
                    configMap: {
                      name: "superset-config",
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    });

    /*───────────────────────────── Superset Service ────────────────────────────*/
    const supersetService = new eks.KubernetesManifest(this, "SupersetService", {
      cluster: props.cluster,
      manifest: [
        {
          apiVersion: "v1",
          kind: "Service",
          metadata: {
            name: "superset",
            namespace: "superset",
            annotations: {
              "service.beta.kubernetes.io/aws-load-balancer-type": "nlb",
              "service.beta.kubernetes.io/aws-load-balancer-scheme": "internet-facing",
            },
          },
          spec: {
            type: "LoadBalancer",
            selector: {
              app: "superset",
            },
            ports: [
              {
                port: 80,
                targetPort: 8088,
                protocol: "TCP",
              },
            ],
          },
        },
      ],
    });

    // Dependencias
    initJob.node.addDependency(supersetConfig);
    supersetDeployment.node.addDependency(initJob);
    supersetService.node.addDependency(supersetDeployment);

    /*───────────────────────────── Outputs ────────────────────────────────*/
    new cdk.CfnOutput(this, "SupersetURLCmd", {
      value:
        "kubectl get svc -n superset superset -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'",
      description: "Comando para obtener la URL de Superset",
    });
    new cdk.CfnOutput(this, "SupersetCredentials", {
      value: "admin@superset.com / admin123",
      description: "Credenciales por defecto de Superset",
    });
    new cdk.CfnOutput(this, "SupersetPort", {
      value: "8088",
      description: "Puerto de Superset",
    });
    new cdk.CfnOutput(this, "SupersetInitJobStatus", {
      value: "kubectl get job -n superset superset-init",
      description: "Comando para verificar el estado del job de inicialización",
    });
  }
}

