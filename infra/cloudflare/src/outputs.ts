/**
 * Reads the DNS targets out of deployed CloudFormation stacks.
 *
 * Read rather than configured: the distribution hostname and the load balancer name
 * are assigned by AWS at deploy time, so any file holding them is a copy that goes
 * stale the first time a stack is replaced — and a stale copy here means DNS quietly
 * pointing at a deployment that no longer exists.
 */

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import type { StackOutputs } from './records.js';

export interface OutputLookup {
  environment: string;
  region: string;
}

async function outputValue(
  client: CloudFormationClient,
  stackName: string,
  outputKey: string,
): Promise<string | undefined> {
  try {
    const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    const outputs = response.Stacks?.[0]?.Outputs ?? [];
    return outputs.find((output) => output.OutputKey === outputKey)?.OutputValue;
  } catch {
    // An undeployed stack is an ordinary state — the CDN stack lands after compute,
    // and DNS is reconciled after both. Treated as "no target yet" rather than an
    // error, so a partial deployment reconciles the half that exists.
    return undefined;
  }
}

export async function readStackOutputs(lookup: OutputLookup): Promise<StackOutputs> {
  const client = new CloudFormationClient({ region: lookup.region });
  const prefix = `Imgopt-${lookup.environment}`;

  /*
   * Only the CDN target comes from a stack now.
   *
   * The control plane's target used to be a load balancer's DNS name, published by the
   * compute stack. It is a Lightsail instance's static IP, which CloudFormation does
   * not know about — Lightsail is not a CloudFormation resource provider — so it
   * arrives from the environment instead, set by whoever attached the address.
   */
  const cdnTarget = await outputValue(client, `${prefix}-Cdn`, 'CdnDnsTarget');
  const apiTarget = process.env['API_STATIC_IP'];

  return {
    ...(cdnTarget !== undefined ? { cdnTarget } : {}),
    ...(apiTarget !== undefined && apiTarget !== '' ? { apiTarget } : {}),
  };
}
