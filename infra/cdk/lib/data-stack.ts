/**
 * Data stack — PostgreSQL in isolated subnets, credentials in Secrets Manager.
 *
 * Stateful and retained, and separated from compute for the same reason as storage:
 * a routine application deploy must not be able to propose replacing the database.
 *
 * Holds metadata only. It is never on the image read path — S3 object existence is
 * the sole authority for whether a derivative can be served — so its availability
 * bounds uploads and the admin API, not delivery. See design.md D1 and D11.
 */

import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from './config.js';

export interface DataStackProps extends StackProps {
  config: EnvironmentConfig;
  vpc: ec2.IVpc;
  /**
   * Created in the network stack along with its one ingress rule, so that no
   * dependency ever has to point from network back to data or compute.
   */
  databaseSecurityGroup: ec2.ISecurityGroup;
}

export class DataStack extends Stack {
  readonly instance: rds.DatabaseInstance;
  readonly secret: secretsmanager.ISecret;
  readonly databaseName = 'imgopt';

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { config, vpc, databaseSecurityGroup } = props;

    this.instance = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: config.database.instanceType,
      vpc,
      // Isolated, not merely private: nothing reaches the database except from
      // inside the VPC, and the database reaches nothing at all.
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      databaseName: this.databaseName,
      // Generated, rotated in Secrets Manager, and never materialized in a template
      // parameter or an environment variable in source.
      credentials: rds.Credentials.fromGeneratedSecret('imgopt'),
      allocatedStorage: config.database.allocatedStorageGb,
      storageEncrypted: true,
      multiAz: config.database.multiAz,
      backupRetention: config.database.backupRetention,
      deleteAutomatedBackups: false,
      deletionProtection: config.database.multiAz,
      removalPolicy: config.removalPolicy,
      cloudwatchLogsExports: ['postgresql'],
    });

    const secret = this.instance.secret;
    if (secret === undefined) {
      throw new Error('Expected a generated credentials secret on the database instance.');
    }
    this.secret = secret;

    new CfnOutput(this, 'DatabaseEndpoint', {
      value: this.instance.dbInstanceEndpointAddress,
    });
    new CfnOutput(this, 'DatabaseSecretArn', { value: this.secret.secretArn });
  }
}
