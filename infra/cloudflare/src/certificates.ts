/**
 * ACM certificate issuance against a zone AWS cannot see.
 *
 * With Route 53, CloudFormation created the certificate and wrote its validation
 * record in one step. With DNS elsewhere that is impossible: the record has to appear
 * in Cloudflare, and a stack waiting for it would simply block until CloudFormation
 * gave up — a deploy that hangs rather than fails, which is worse.
 *
 * So issuance moves here, ahead of the deploy: request the certificate, write the
 * validation record into Cloudflare, wait for ACM to see it, and print the ARN to
 * feed back as `CDN_CERTIFICATE_ARN` / `API_CERTIFICATE_ARN`.
 *
 * THE VALIDATION RECORD IS PERMANENT. It is tempting to delete it once the
 * certificate is issued; do not. ACM re-checks it to renew, roughly every 11 months,
 * and a missing record turns renewal into a silent failure that surfaces as an
 * expired certificate on a date nobody has in their calendar.
 */

import {
  ACMClient,
  DescribeCertificateCommand,
  RequestCertificateCommand,
  type CertificateDetail,
} from '@aws-sdk/client-acm';
import type { CloudflareClient } from './api.js';

export interface IssueOptions {
  domainName: string;
  /** us-east-1 for the distribution; the deployment's own region for the ALB. */
  region: string;
  cloudflare: CloudflareClient;
  /** How long to wait for ACM to observe the record before giving up. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 15 * 1000;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The validation record ACM is waiting for, once it has published one.
 *
 * ACM does not return it immediately after `RequestCertificate` — the field is empty
 * for a few seconds — which is why this polls rather than reading once and failing.
 */
async function validationRecord(
  client: ACMClient,
  certificateArn: string,
  sleep: (ms: number) => Promise<void>,
): Promise<{ name: string; value: string }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const described = await client.send(
      new DescribeCertificateCommand({ CertificateArn: certificateArn }),
    );
    const option = described.Certificate?.DomainValidationOptions?.[0]?.ResourceRecord;

    if (option?.Name !== undefined && option.Value !== undefined) {
      return { name: option.Name, value: option.Value };
    }
    await sleep(2000);
  }

  throw new Error(
    `ACM never published a validation record for ${certificateArn}. ` +
      'Check the certificate in the console before requesting another.',
  );
}

/**
 * Requests a certificate, plants its validation record, and waits for issuance.
 *
 * Returns the ARN. Safe to re-run only in the sense that it will request a *new*
 * certificate — ACM has no idempotency key here, so a second run leaves an unused
 * certificate behind. Check for an existing one before calling.
 */
export async function issueCertificate(options: IssueOptions): Promise<string> {
  const log =
    options.log ??
    ((message: string) => {
      console.log(message);
    });
  const sleep = options.sleep ?? wait;
  const client = new ACMClient({ region: options.region });

  const requested = await client.send(
    new RequestCertificateCommand({
      DomainName: options.domainName,
      ValidationMethod: 'DNS',
      // Renewal re-validates through the same record, so the zone entry below has to
      // outlive issuance.
      Options: { CertificateTransparencyLoggingPreference: 'ENABLED' },
    }),
  );

  const certificateArn = requested.CertificateArn;
  if (certificateArn === undefined) {
    throw new Error(`ACM did not return an ARN for ${options.domainName}.`);
  }
  log(`requested ${certificateArn}`);

  const record = await validationRecord(client, certificateArn, sleep);

  // A CNAME, DNS-only. Cloudflare would refuse to proxy this anyway — it is not an
  // HTTP endpoint — but stating it keeps the rule uniform across this package.
  await options.cloudflare.createRecord({
    name: record.name.replace(/\.$/, ''),
    type: 'CNAME',
    content: record.value.replace(/\.$/, ''),
    proxied: false,
    comment: `ACM validation for ${options.domainName} — permanent, renewal re-checks it`,
  });
  log(`validation record written: ${record.name} -> ${record.value}`);

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_MS;

  for (;;) {
    const described = await client.send(
      new DescribeCertificateCommand({ CertificateArn: certificateArn }),
    );
    const status = described.Certificate?.Status;

    if (status === 'ISSUED') {
      log(`issued ${certificateArn}`);
      return certificateArn;
    }
    if (status === 'FAILED' || status === 'VALIDATION_TIMED_OUT') {
      throw new Error(
        `Certificate ${certificateArn} ended in ${status}. ` +
          `${failureHint(described.Certificate)}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${certificateArn}. The record is planted, so this may ` +
          'simply be slow — re-check with `aws acm describe-certificate` rather than ' +
          'requesting a second certificate.',
      );
    }

    await sleep(interval);
  }
}

/** The two causes worth naming, because the console message names neither. */
function failureHint(certificate: CertificateDetail | undefined): string {
  const reason = certificate?.FailureReason;
  if (reason !== undefined) return `Reason: ${reason}.`;
  return (
    'The usual causes are a CAA record on the zone that does not permit amazon.com, ' +
    'or the validation record being proxied rather than DNS-only.'
  );
}
