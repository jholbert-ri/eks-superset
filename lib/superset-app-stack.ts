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

# Database configuration
SQLALCHEMY_DATABASE_URI = os.getenv('SQLALCHEMY_DATABASE_URI')

# Redis configuration
REDIS_HOST = os.getenv('REDIS_HOST', 'redis')
REDIS_PORT = os.getenv('REDIS_PORT', '6379')

# Cache configuration
CACHE_CONFIG = {
    'CACHE_TYPE': 'RedisCache',
    'CACHE_DEFAULT_TIMEOUT': 300,
    'CACHE_KEY_PREFIX': 'superset_',
    'CACHE_REDIS_HOST': REDIS_HOST,
    'CACHE_REDIS_PORT': REDIS_PORT,
    'CACHE_REDIS_DB': 1,
}

# Celery configuration
class CeleryConfig:
    broker_url = f"redis://{REDIS_HOST}:{REDIS_PORT}/0"
    imports = (
        "superset.sql_lab",
        "superset.tasks.cache",
    )
    result_backend = f"redis://{REDIS_HOST}:{REDIS_PORT}/0"
    task_annotations = {
        "sql_lab.get_sql_results": {
            "rate_limit": "100/s",
        },
    }

CELERY_CONFIG = CeleryConfig

# Security
SECRET_KEY = os.getenv('SECRET_KEY')
WTF_CSRF_ENABLED = True
WTF_CSRF_TIME_LIMIT = None

# Feature flags
FEATURE_FLAGS = {
    "ENABLE_TEMPLATE_PROCESSING": True,
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

    /*───────────────────────────── Redis Deployment ──────────────────────────*/
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
                ports: [
                  {
                    containerPort: 6379,
                  },
                ],
                resources: {
                  requests: {
                    memory: "256Mi",
                    cpu: "250m",
                  },
                  limits: {
                    memory: "512Mi",
                    cpu: "500m",
                  },
                },
                livenessProbe: {
                  tcpSocket: {
                    port: 6379,
                  },
                  initialDelaySeconds: 30,
                  timeoutSeconds: 5,
                },
                readinessProbe: {
                  tcpSocket: {
                    port: 6379,
                  },
                  initialDelaySeconds: 5,
                  timeoutSeconds: 1,
                },
              },
            ],
          },
        },
      },
    });

    /*───────────────────────────── Redis Service ──────────────────────────*/
    const redisService = props.cluster.addManifest("RedisService", {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: "redis",
        namespace: "superset",
      },
      spec: {
        selector: {
          app: "redis",
        },
        ports: [
          {
            port: 6379,
            targetPort: 6379,
          },
        ],
      },
    });

    /*───────────────────────────── Init Job ────────────────────────────────*/
    const initJob = props.cluster.addManifest("SupersetInitJob", {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: "superset-init",
        namespace: "superset",
      },
      spec: {
        template: {
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "superset-init",
                image: "apache/superset:latest",
                command: ["/bin/bash", "-c"],
                args: [
                  `
                  echo "Iniciando configuración de Superset..."
                  
                  # Instalar driver de PostgreSQL
                  pip install psycopg2-binary
                  
                  # Configurar Superset
                  superset db upgrade
                  
                  # Crear usuario admin
                  superset fab create-admin \\
                    --username admin \\
                    --firstname Admin \\
                    --lastname User \\
                    --email admin@superset.com \\
                    --password admin123
                  
                  # Inicializar Superset
                  superset init
                  
                  # Cargar ejemplos (opcional)
                  superset load_examples
                  
                  echo "Configuración completada"
                  `,
                ],
                envFrom: [
                  {
                    secretRef: {
                      name: "superset-db-uri",
                    },
                  },
                ],
                env: [
                  {
                    name: "SUPERSET_CONFIG_PATH",
                    value: "/etc/superset/superset_config.py",
                  },
                  {
                    name: "REDIS_HOST",
                    value: "redis",
                  },
                  {
                    name: "REDIS_PORT",
                    value: "6379",
                  },
                ],
                volumeMounts: [
                  {
                    name: "superset-config",
                    mountPath: "/etc/superset",
                  },
                ],
                resources: {
                  requests: {
                    memory: "1Gi",
                    cpu: "500m",
                  },
                  limits: {
                    memory: "2Gi",
                    cpu: "1000m",
                  },
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
        backoffLimit: 3,
      },
    });

    /*───────────────────────────── Superset Deployment ────────────────────*/
    const supersetDeployment = props.cluster.addManifest("SupersetDeployment", {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: "superset",
        namespace: "superset",
      },
      spec: {
        replicas: 2,
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
                image: "apache/superset:latest",
                ports: [
                  {
                    containerPort: 8088,
                  },
                ],
                command: ["/bin/bash", "-c"],
                args: [
                  `
                  # Instalar driver de PostgreSQL
                  pip install psycopg2-binary
                  
                  # Ejecutar Superset
                  gunicorn \\
                    --bind 0.0.0.0:8088 \\
                    --workers 4 \\
                    --worker-class gthread \\
                    --threads 20 \\
                    --timeout 60 \\
                    --keep-alive 2 \\
                    --max-requests 1000 \\
                    --max-requests-jitter 100 \\
                    --preload \\
                    --limit-request-line 0 \\
                    --limit-request-field_size 0 \\
                    "superset.app:create_app()"
                  `,
                ],
                env: [
                  {
                    name: "SUPERSET_ENV",
                    value: "production",
                  },
                  {
                    name: "SUPERSET_CONFIG_PATH",
                    value: "/etc/superset/superset_config.py",
                  },
                  {
                    name: "REDIS_HOST",
                    value: "redis",
                  },
                  {
                    name: "REDIS_PORT",
                    value: "6379",
                  },
                ],
                envFrom: [
                  {
                    secretRef: {
                      name: "superset-db-uri",
                    },
                  },
                ],
                volumeMounts: [
                  {
                    name: "superset-config",
                    mountPath: "/etc/superset",
                  },
                ],
                resources: {
                  requests: {
                    memory: "2Gi",
                    cpu: "1000m",
                  },
                  limits: {
                    memory: "4Gi",
                    cpu: "2000m",
                  },
                },
                livenessProbe: {
                  httpGet: {
                    path: "/health",
                    port: 8088,
                  },
                  initialDelaySeconds: 60,
                  periodSeconds: 30,
                  timeoutSeconds: 10,
                  failureThreshold: 3,
                },
                readinessProbe: {
                  httpGet: {
                    path: "/health",
                    port: 8088,
                  },
                  initialDelaySeconds: 30,
                  periodSeconds: 10,
                  timeoutSeconds: 5,
                  failureThreshold: 3,
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
    });

    /*───────────────────────────── Superset Service ───────────────────────*/
    const supersetService = props.cluster.addManifest("SupersetService", {
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
            port: 8088,
            targetPort: 8088,
            protocol: "TCP",
          },
        ],
      },
    });

    /*───────────────────────────── Dependencias ────────────────────────────*/
    redisService.node.addDependency(redisDeployment);
    supersetConfig.node.addDependency(props.albControllerChart);
    initJob.node.addDependency(redisService);
    initJob.node.addDependency(supersetConfig);
    supersetDeployment.node.addDependency(initJob);
    supersetService.node.addDependency(supersetDeployment);

    /*───────────────────────────── Outputs ────────────────────────────────*/
    new cdk.CfnOutput(this, "SupersetURLCmd", {
      value: "kubectl get svc -n superset superset -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'",
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
