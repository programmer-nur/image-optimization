/**
 * A DNS-validated certificate for one hostname.
 *
 * Region-agnostic by design; the *caller* decides where it lives, and the deployment
 * needs two of these in two different regions:
 *
 * - the distribution's viewer certificate, which CloudFront accepts only from
 *   us-east-1 whatever region everything else is in — a CloudFront constraint, not a
 *   choice, and the reason this is a stack rather than a construct: a stack has
 *   exactly one region;
 * - the load balancer's certificate, which must be in the deployment's own region,
 *   because an ALB cannot attach a certificate from anywhere else.
 *
 * They are two certificates for two different names, and substituting one for the
 * other fails at attach time rather than at synth.
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

export interface CertificateStackProps extends StackProps {
  /** The name the certificate is issued for. */
  domainName: string;
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

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      // Validation records are written into the zone automatically, so issuance
      // needs no console step.
      validation: acm.CertificateValidation.fromDns(zone),
    });
  }
}
