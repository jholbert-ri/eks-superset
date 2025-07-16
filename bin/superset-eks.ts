#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import "source-map-support/register";
import { SupersetMinimalStack } from "../lib/eks-minimal";

const app = new cdk.App();

// Obtener el nombre del cluster existente del contexto o environment
const existingClusterName = app.node.tryGetContext("clusterName");

new SupersetMinimalStack(app, "SupersetMinimalStack", {
  existingVpcId: "vpc-xxxxxx", // Tu VPC ID
  existingClusterName: existingClusterName, // Será undefined si no se proporciona
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
