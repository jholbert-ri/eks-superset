import * as cdk from "aws-cdk-lib";
import { Environment } from "./constants";

export interface SupersetEksStackProps extends cdk.StackProps {
  environment: Environment;
  vpcId: string;
}
