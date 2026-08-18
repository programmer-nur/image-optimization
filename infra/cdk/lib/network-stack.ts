/**
 * Network stack — VPC, subnets, and the endpoints that keep traffic off the NAT.
 *
 * Changes rarely and everything else depends on it, so it is separated from compute:
 * redeploying application code must never risk a subnet.
 */

import { Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from './config.js';

export interface NetworkStackProps extends StackProps {
  config: EnvironmentConfig;
}

/**
 * Every security group and every rule between them lives here, including the ones
 * that describe compute.
 *
 * That looks like a layering violation and is the opposite. A security group is
 * defined in whichever stack creates it, but a *rule* is created in whichever stack
 * calls `allowFrom` — so letting the compute stack wire the load balancer to the
 * tasks writes a rule into the network stack that references a compute resource,
 * while compute already depends on network for the VPC. CloudFormation rejects the
 * resulting cycle, and the error names forty route-table associations rather than
 * the one line that caused it.
 *
 * Declaring the topology in one place keeps the dependency arrows pointing one way.
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  /** Lambdas and Fargate tasks. */
  readonly appSecurityGroup: ec2.SecurityGroup;
  /** Public-facing load balancer. */
  readonly albSecurityGroup: ec2.SecurityGroup;
  /** PostgreSQL. Accepts traffic from the application group and nothing else. */
  readonly databaseSecurityGroup: ec2.SecurityGroup;

  /** Container port the load balancer forwards to. */
  static readonly APP_PORT = 3000;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: config.network.maxAzs,
      natGateways: config.network.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        // The database sits in subnets with no route out at all. Nothing in this
        // deployment needs the database to reach the internet, and an isolated
        // subnet makes that structural rather than a security-group promise.
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // A gateway endpoint costs nothing and keeps every object read and write off the
    // NAT. On this workload that is not a rounding error: the optimizer and the
    // generator move whole images through S3, and NAT data processing is billed per
    // gigabyte in both directions.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    this.appSecurityGroup = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
      vpc: this.vpc,
      description: 'Control plane tasks and processing functions',
      allowAllOutbound: true,
    });

    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      description: 'Public application load balancer',
      allowAllOutbound: true,
    });

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      description: 'PostgreSQL; reachable only from the application security group',
      allowAllOutbound: false,
    });

    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'HTTPS');
    /*
     * Port 80 has two lives, and the comment used to describe only the first.
     *
     * With a certificate configured — always, in production, where synthesis fails
     * without one — the listener on 80 exists solely to redirect to 443 and no
     * request is served over it. Without one, which staging is allowed to be before
     * DNS exists, 80 *is* the listener and requests really are served in clear. Both
     * rules stay either way; what changes is which of those two things is true.
     */
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP redirect');
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'HTTP redirect');

    this.appSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(NetworkStack.APP_PORT),
      'Load balancer to control plane tasks',
    );

    this.databaseSecurityGroup.addIngressRule(
      this.appSecurityGroup,
      ec2.Port.tcp(5432),
      'Control plane and processing functions',
    );

    // Interface endpoints are hourly-priced per AZ, so only the services actually on
    // a hot path get one. Everything else goes via the NAT.
    const interfaceEndpoints: Array<[string, ec2.InterfaceVpcEndpointAwsService]> = [
      ['SqsEndpoint', ec2.InterfaceVpcEndpointAwsService.SQS],
      ['SecretsManagerEndpoint', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ['LogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
    ];

    for (const [id_, service] of interfaceEndpoints) {
      this.vpc.addInterfaceEndpoint(id_, {
        service,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.appSecurityGroup],
        privateDnsEnabled: true,
      });
    }
  }
}
