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

/*
 * Two certificates, in two regions, for two different names.
 *
 * The distribution's must be in us-east-1 whatever region everything else is in —
 * a CloudFront constraint — while the load balancer's must be in the deployment's own
 * region. Each is issued here only when the hosted zone is in this account, since DNS
 * validation cannot complete otherwise; with an external zone the operator supplies
 * an ARN and the corresponding stack is skipped entirely.
 *
 * The API certificate is created before the compute stack because compute consumes
 * it. Missing that wiring is how the control plane came to serve plain HTTP: the prop
 * existed, and nothing ever passed it.
 */
const zoneIsOurs = config.hostedZoneId !== undefined && config.hostedZoneName !== undefined;

const certificate =
  config.cdnCertificateArn === undefined && zoneIsOurs
    ? new CertificateStack(app, `${prefix}-Certificate`, {
        env: { account: config.account, region: 'us-east-1' },
        domainName: config.cdnHost,
        hostedZoneId: config.hostedZoneId!,
        hostedZoneName: config.hostedZoneName!,
        crossRegionReferences: true,
      })
    : undefined;

const apiCertificate =
  config.apiCertificateArn === undefined && config.apiHost !== undefined && zoneIsOurs
    ? new CertificateStack(app, `${prefix}-ApiCertificate`, {
        // Same region as the ALB: an ALB cannot attach a certificate from another.
        env,
        domainName: config.apiHost,
        hostedZoneId: config.hostedZoneId!,
        hostedZoneName: config.hostedZoneName!,
      })
    : undefined;

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
  ...(apiCertificate !== undefined ? { apiCertificate: apiCertificate.certificate } : {}),
});

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
  // Read off the constructs, not retyped. A hand-written name is a latent
  // silent disarm: rename the function and the alarm watches a name nothing
  // publishes, which reads as permanent health.
  optimizerFunctionName: compute.optimizer.functionName,
  maintenanceFunctionName: compute.maintenance.functionName,
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
if (apiCertificate !== undefined) compute.addStackDependency(apiCertificate);
cdn.addStackDependency(compute);
cdn.addStackDependency(storage);
compute.addStackDependency(data);
compute.addStackDependency(storage);
compute.addStackDependency(queue);
data.addStackDependency(network);
observability.addStackDependency(cdn);
observability.addStackDependency(compute);

// Every stack, including the certificate stacks — which were previously omitted, so
// the two resources most likely to be found by someone auditing a bill carried no
// Application or Environment tag.
const tagged = [
  network,
  storage,
  queue,
  data,
  compute,
  cdn,
  observability,
  certificate,
  apiCertificate,
];

for (const stack of tagged) {
  if (stack === undefined) continue;
  Tags.of(stack).add('Application', 'imgopt');
  Tags.of(stack).add('Environment', config.name);
}
