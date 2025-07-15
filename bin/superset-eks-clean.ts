#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AwsAccounts, AwsRegions, AwsVPC, Environment } from "../lib/constants";
import { SupersetMinimalStack } from "../lib/eks-minimal";
import {
  SupersetAppStack,
  SupersetAppStackProps,
} from "../lib/superset-app-stack";
import { SupersetInfraStack } from "../lib/superset-infra-stack";

const app = new cdk.App();

/*────── Config común ─────*/
const env = {
  account: AwsAccounts.BETA,
  region: AwsRegions.SAEAST1,
};

/*────── Infraestructura ───*/
const infra = new SupersetInfraStack(app, "SupersetInfraBetaV2", {
  env,
  environment: Environment.BETA,
  vpcId: AwsVPC.BETA,
});

/*────── Aplicación ────────*/
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

/* El AppStack depende explícitamente del InfraStack */
appStack.addDependency(infra);

new SupersetMinimalStack(app, "SupersetMinimalStack", {
  env: { account: AwsAccounts.BETA, region: AwsRegions.SAEAST1 },
  existingVpcId: AwsVPC.BETA,
});
