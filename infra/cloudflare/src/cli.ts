/**
 * `pnpm --filter @imgopt/cloudflare dns` / `... certs`
 *
 * Two commands, both read-only until told otherwise: `dns` prints a plan and only
 * writes with `--apply`, and `certs` names what it will request before requesting it.
 * DNS changes are the kind that take a domain offline, so the default is to show.
 */

import { CloudflareClient } from './api.js';
import { issueCertificate } from './certificates.js';
import { readStackOutputs } from './outputs.js';
import { desiredRecords, formatPlan, reconcile } from './records.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing ${name}. See infra/cloudflare/README.md.`);
  }
  return value;
}

function client(): CloudflareClient {
  return new CloudflareClient({
    // Scoped token, not a global key: this needs Zone:DNS:Edit on one zone and
    // nothing else, and a global key would let a deploy script edit every domain in
    // the account.
    token: required('CLOUDFLARE_API_TOKEN'),
    zoneId: required('CLOUDFLARE_ZONE_ID'),
  });
}

async function dns(apply: boolean): Promise<void> {
  const environment = process.env['IMGOPT_ENV'] ?? 'staging';
  const region = process.env['CDK_REGION'] ?? 'us-east-1';

  const hosts = {
    cdnHost: required('CDN_HOST'),
    ...(process.env['API_HOST'] !== undefined ? { apiHost: process.env['API_HOST'] } : {}),
  };

  const outputs = await readStackOutputs({ environment, region });
  const cloudflare = client();
  const existing = await cloudflare.listRecords();

  const desired = desiredRecords(hosts, outputs);
  const { changes, conflicts } = reconcile(desired, existing);

  console.log(`Plan for ${environment} (${region}):`);
  console.log(formatPlan(changes, conflicts));

  if (conflicts.length > 0) {
    throw new Error('Conflicting records exist; resolve them by hand before applying.');
  }
  if (!apply) {
    console.log('\nRun again with --apply to write these.');
    return;
  }

  for (const change of changes) {
    if (change.action === 'unchanged') continue;

    if (change.action === 'create') {
      await cloudflare.createRecord(change.record);
      console.log(`created ${change.record.name}`);
    } else {
      await cloudflare.updateRecord(change.id, change.record);
      console.log(`updated ${change.record.name}`);
    }
  }
}

async function certs(): Promise<void> {
  const region = process.env['CDK_REGION'] ?? 'us-east-1';
  const cloudflare = client();

  const targets: Array<{ label: string; domainName: string; region: string; envVar: string }> = [
    {
      label: 'distribution',
      domainName: required('CDN_HOST'),
      // CloudFront accepts a viewer certificate only from us-east-1, wherever the
      // rest of the deployment lives.
      region: 'us-east-1',
      envVar: 'CDN_CERTIFICATE_ARN',
    },
  ];

  if (process.env['API_HOST'] !== undefined && process.env['API_HOST'] !== '') {
    targets.push({
      label: 'load balancer',
      domainName: process.env['API_HOST'],
      // An ALB accepts one only from its own region. Two certificates, always.
      region,
      envVar: 'API_CERTIFICATE_ARN',
    });
  }

  for (const target of targets) {
    console.log(
      `\nRequesting the ${target.label} certificate for ${target.domainName} in ${target.region}…`,
    );
    const arn = await issueCertificate({
      domainName: target.domainName,
      region: target.region,
      cloudflare,
    });
    console.log(`export ${target.envVar}=${arn}`);
  }

  console.log(
    '\nLeave the validation records in place. ACM re-checks them to renew, and ' +
      'deleting them turns renewal into a silent failure ~11 months from now.',
  );
}

const [command, ...flags] = process.argv.slice(2);

try {
  if (command === 'dns') {
    await dns(flags.includes('--apply'));
  } else if (command === 'certs') {
    await certs();
  } else {
    console.error('Usage: cli.ts <dns [--apply] | certs>');
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
