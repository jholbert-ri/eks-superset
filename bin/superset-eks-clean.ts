#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AwsAccounts, AwsRegions, AwsVPC, Environment } from "../lib/constants";
import { SupersetMinimalStack } from "../lib/eks-minimal";

const app = new cdk.App();

/*────── Config común ─────*/
const env = {
  account: AwsAccounts.BETA,
  region: AwsRegions.SAEAST1,
};

// Nombre del cluster existente
const existingClusterName =
  "SupersetClusterB38A40B0-4c56592879f746fcb953cd4907ba80af";

// Stack minimo solo para ALB
new SupersetMinimalStack(app, "SupersetMinimalStack", {
  existingVpcId: AwsVPC.BETA,
  existingClusterName: existingClusterName,
  env,
  tags: {
    Environment: Environment.BETA,
    Project: "superset",
  },
});

/* Comentado temporalmente mientras trabajamos con el stack mínimo
────── Infraestructura ───
const infra = new SupersetInfraStack(app, "SupersetInfraBetaV2", {
  env,
  environment: Environment.BETA,
  vpcId: AwsVPC.BETA,
});

────── Aplicación ────────
const appProps: SupersetAppStackProps = {
  env,
  environment: Environment.BETA,
  vpcId: AwsVPC.BETA,
  cluster: infra.cluster,
  database: infra.database,
  dbSecret: infra.dbSecret,
  flaskSecret: infra.flaskSecret,
  albControllerChart: infra.albControllerChart,
  dbSecretArn: infra.dbSecret.secretArn,
  flaskSecretArn: infra.flaskSecret.secretArn,
};

const appStack = new SupersetAppStack(app, "SupersetAppBetaV3", appProps);

 El AppStack depende explícitamente del InfraStack 
appStack.addDependency(infra);
*/
