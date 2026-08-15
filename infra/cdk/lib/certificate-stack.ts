/**
 * Certificate stack — pinned to us-east-1.
 *
 * CloudFront accepts a viewer certificate only from us-east-1, whatever region the
 * rest of the deployment lives in. That is a CloudFront constraint, not a choice,
 * and it is the reason this is a separate stack rather than a construct in the CDN
 * stack: a stack has exactly one region.
 *
 * Only instantiated when the hosted zone is in this account. DNS validation cannot
 * complete otherwise, and a certificate stuck in PENDING_VALIDATION blocks the
 * deployment for the full validation timeout before failing — so an externally
 * managed zone takes the bring-your-own-ARN path instead.
 */

import { Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from './config.js';

export interface CertificateStackProps extends StackProps {
  config: EnvironmentConfig;
  hostedZoneId: string;
  hostedZoneName: string;
}

export class CertificateStack extends Stack {
  readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName,
    });

    this.certificate = new acm.Certificate(this, 'CdnCertificate', {
      domainName: props.config.cdnHost,
      // Validation records are written into the zone automatically, so issuance
      // needs no console step.
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
}
