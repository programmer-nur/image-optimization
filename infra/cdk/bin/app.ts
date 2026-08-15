#!/usr/bin/env node
/**
 * CDK entry point.
 *
 * Stacks are split by lifecycle, and the dependency order below is also the deploy
 * order. The split exists so that shipping application code — which happens many
 * times a week — touches only Compute, and can never present CloudFormation with a
 * plan that replaces the bucket holding every original or the database holding every
 * asset record.
 *
 *   Network   rarely            VPC, subnets, endpoints
 *   Storage   never             the bucket, retained
 *   Data      never             PostgreSQL, retained
 *   Queue     rarely            optimize queue + DLQ
 *   Compute   every release     Lambdas, Fargate, migrations
 *   Cdn       occasionally      distribution, edge function, DNS
 */

import { App, Tags } from 'aws-cdk-lib';
import { resolveEnvironment } from '../lib/config.js';
import { NetworkStack } from '../lib/network-stack.js';
import { StorageStack } from '../lib/storage-stack.js';
import { DataStack } from '../lib/data-stack.js';
import { QueueStack } from '../lib/queue-stack.js';
import { ComputeStack } from '../lib/compute-stack.js';
import { CdnStack } from '../lib/cdn-stack.js';
import { CertificateStack } from '../lib/certificate-stack.js';
import { ObservabilityStack } from '../lib/observability-stack.js';

const app = new App();

const config = resolveEnvironment(
  (app.node.tryGetContext('env') as string | undefined) ?? process.env['IMGOPT_ENV'],
);

const env = { account: config.account, region: config.region };
const prefix = `Imgopt-${config.name}`;

const network = new NetworkStack(app, `${prefix}-Network`, { env, config });
const storage = new StorageStack(app, `${prefix}-Storage`, { env, config });
const queue = new QueueStack(app, `${prefix}-Queue`, { env, config });

const data = new DataStack(app, `${prefix}-Data`, {
  env,
  config,
  vpc: network.vpc,
  databaseSecurityGroup: network.databaseSecurityGroup,
});

const compute = new ComputeStack(app, `${prefix}-Compute`, {
  env,
  config,
  vpc: network.vpc,
  appSecurityGroup: network.appSecurityGroup,
  albSecurityGroup: network.albSecurityGroup,
  bucket: storage.bucket,
  optimizeQueue: queue.optimizeQueue,
  database: data.instance,
  databaseSecret: data.secret,
  databaseName: data.databaseName,
});

/*
 * The viewer certificate has to be in us-east-1 whatever region everything else is
 * in, so it gets its own stack. Only issued here when the hosted zone is in this
 * account; otherwise the operator supplies an ARN and this is skipped entirely.
 */
const needsCertificate =
  config.cdnCertificateArn === undefined &&
  config.hostedZoneId !== undefined &&
  config.hostedZoneName !== undefined;

const certificate = needsCertificate
  ? new CertificateStack(app, `${prefix}-Certificate`, {
      env: { account: config.account, region: 'us-east-1' },
      config,
      hostedZoneId: config.hostedZoneId!,
      hostedZoneName: config.hostedZoneName!,
      crossRegionReferences: true,
    })
  : undefined;

const cdn = new CdnStack(app, `${prefix}-Cdn`, {
  env,
  config,
  generatorFunctionUrl: compute.generatorFunctionUrl,
  // Lets the distribution reference a certificate in another region.
  crossRegionReferences: true,
  ...(certificate !== undefined ? { issuedCertificate: certificate.certificate } : {}),
});

/*
 * Alarms and the dashboard, last.
 *
 * Takes resource *names* rather than constructs. Referencing the constructs would
 * make compute and CDN depend on observability, so tuning an alarm threshold — which
 * is something done during an incident — would require redeploying the service the
 * alarm watches.
 */
const observability = new ObservabilityStack(app, `${prefix}-Observability`, {
  env,
  config,
  optimizeQueueName: queue.optimizeQueue.queueName,
  deadLetterQueueName: queue.deadLetterQueue.queueName,
  generatorFunctionName: compute.generator.functionName,
  optimizerFunctionName: `imgopt-${config.name}-optimizer`,
  distributionId: cdn.distribution.distributionId,
  loadBalancerFullName: compute.loadBalancer.loadBalancerFullName,
  targetGroupFullName: compute.targetGroupFullName,
});

/*
 * Explicit ordering.
 *
 * Most of these arrows already exist implicitly through resource references, but
 * stating them keeps the deploy order readable and stops a future refactor that
 * removes one reference from silently reordering the deployment.
 */
if (certificate !== undefined) cdn.addStackDependency(certificate);
cdn.addStackDependency(compute);
cdn.addStackDependency(storage);
compute.addStackDependency(data);
compute.addStackDependency(storage);
compute.addStackDependency(queue);
data.addStackDependency(network);
observability.addStackDependency(cdn);
observability.addStackDependency(compute);

for (const stack of [network, storage, queue, data, compute, cdn, observability]) {
  Tags.of(stack).add('Application', 'imgopt');
  Tags.of(stack).add('Environment', config.name);
}
