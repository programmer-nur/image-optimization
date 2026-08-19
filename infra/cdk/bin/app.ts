#!/usr/bin/env node
/**
 * CDK entry point.
 *
 * Stacks are split by lifecycle, and the dependency order below is also the deploy
 * order. The split exists so that shipping application code — which happens many
 * times a week — touches only Compute, and can never present CloudFormation with a
 * plan that replaces the bucket holding every original.
 *
 *   Storage         never             the bucket, retained
 *   Queue           rarely            optimize queue + DLQ
 *   Compute         every release     both Lambdas, the control plane's IAM identity
 *   Cdn             occasionally      distribution, edge function
 *   Observability   during incidents  alarms and the dashboard
 *
 * **What is not here.** No network stack: neither Lambda is VPC-attached, so there is
 * no VPC, no NAT gateway, and no interface endpoints (design.md L1). No data stack:
 * PostgreSQL is a Lightsail managed database, provisioned outside CloudFormation
 * because Lightsail is not a CloudFormation resource provider. The control plane
 * itself is a Lightsail instance, deployed by `deploy/lightsail/deploy.sh` rather than
 * by this app — see docs/bootstrap.md.
 */

import { App, Tags } from 'aws-cdk-lib';
import { resolveEnvironment } from '../lib/config.js';
import { StorageStack } from '../lib/storage-stack.js';
import { QueueStack } from '../lib/queue-stack.js';
import { ComputeStack } from '../lib/compute-stack.js';
import { CdnStack } from '../lib/cdn-stack.js';
import { ObservabilityStack } from '../lib/observability-stack.js';

const app = new App();

const config = resolveEnvironment(
  (app.node.tryGetContext('env') as string | undefined) ?? process.env['IMGOPT_ENV'],
);

const env = { account: config.account, region: config.region };
const prefix = `Imgopt-${config.name}`;

const storage = new StorageStack(app, `${prefix}-Storage`, { env, config });
const queue = new QueueStack(app, `${prefix}-Queue`, { env, config });

const compute = new ComputeStack(app, `${prefix}-Compute`, {
  env,
  config,
  bucket: storage.bucket,
  optimizeQueue: queue.optimizeQueue,
});

/*
 * The distribution's certificate arrives as an ARN; nothing here issues one.
 *
 * DNS is in Cloudflare (design.md D18), so a DNS-validated certificate cannot be
 * created and validated inside a CloudFormation deployment — the validation record
 * has to appear in a zone CloudFormation cannot write to, and the stack would block
 * until it timed out. `infra/cloudflare` requests it, writes its validation record,
 * waits for issuance, and prints the ARN to set here.
 *
 * One certificate now, not two: the control plane terminates its own TLS on the
 * Lightsail instance with an automatically renewed certificate, and ACM cannot be
 * attached to a Lightsail instance anyway (design.md L3).
 */
const cdn = new CdnStack(app, `${prefix}-Cdn`, {
  env,
  config,
  generatorFunctionUrl: compute.generatorFunctionUrl,
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
  // Read off the constructs, not retyped. A hand-written name is a latent
  // silent disarm: rename the function and the alarm watches a name nothing
  // publishes, which reads as permanent health.
  optimizerFunctionName: compute.optimizer.functionName,
  distributionId: cdn.distribution.distributionId,
});

/*
 * Explicit ordering.
 *
 * Most of these arrows already exist implicitly through resource references, but
 * stating them keeps the deploy order readable and stops a future refactor that
 * removes one reference from silently reordering the deployment.
 */
cdn.addStackDependency(compute);
cdn.addStackDependency(storage);
compute.addStackDependency(storage);
compute.addStackDependency(queue);
observability.addStackDependency(cdn);
observability.addStackDependency(compute);

for (const stack of [storage, queue, compute, cdn, observability]) {
  Tags.of(stack).add('Application', 'imgopt');
  Tags.of(stack).add('Environment', config.name);
}
