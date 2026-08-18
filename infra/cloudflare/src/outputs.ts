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

  const [cdnTarget, apiTarget] = await Promise.all([
    outputValue(client, `${prefix}-Cdn`, 'CdnDnsTarget'),
    outputValue(client, `${prefix}-Compute`, 'ApiDnsTarget'),
  ]);

  return {
    ...(cdnTarget !== undefined ? { cdnTarget } : {}),
    ...(apiTarget !== undefined ? { apiTarget } : {}),
  };
}
