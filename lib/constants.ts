export enum Environment {
  BETA = "beta",
  STAGING = "staging",
  PROD = "prod",
}

export enum AwsAccounts {
  BETA = "730335418300",
  STAGING = "", // Pendiente de definir
  PROD = "", // Pendiente de definir
}

export enum AwsVPC {
  BETA = "vpc-0072a792fee9ee196",
  STAGING = "", // Pendiente de definir
  PROD = "", // Pendiente de definir
}

export enum AwsRegions {
  SAEAST1 = "sa-east-1",
}

export interface StackConfig {
  environment: Environment;
  account: string;
  region: string;
  vpcId: string;
}
