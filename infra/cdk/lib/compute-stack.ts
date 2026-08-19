/**
 * Compute stack — the two Lambdas, and the identity the control-plane host uses.
 *
 * This is the stack that changes on every release, which is exactly why storage and
 * the queue are not in it. Deploying application code must never present
 * CloudFormation with the option of replacing the bucket holding every original.
 *
 * **What is not here any more.** There is no ECS cluster, no Fargate service, no load
 * balancer, no ECR repository, no regional WAF, no RDS instance, and no VPC. The
 * control plane runs on a Lightsail instance provisioned outside CloudFormation
 * (design.md L3), and reclamation runs beside its database rather than in Lambda
 * (L2). What remains is what genuinely wants to be serverless: two functions that do
 * image work, sized against bursts nobody schedules.
 *
 * **Neither Lambda is VPC-attached, and that is the point.** They held a database
 * connection, which is the only thing that ever required a VPC, and a VPC is what a
 * NAT gateway and six interface endpoints existed to serve — $76.65/month, 32% of the
 * old fixed floor, spent on reaching Postgres. They post their bookkeeping to the
 * control plane instead. Putting either back in a VPC brings all of that back with it.
 *
 * IAM here is scoped by *prefix*, not by bucket. The four prefixes have four trust
 * levels, and a role that can write `original/` is a role that can rewrite history.
 */

import {
  CfnOutput,
  RemovalPolicy,
  Stack,
  aws_lambda_event_sources as eventsources,
  type StackProps,
} from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from './config.js';
import { generatorBundle, optimizerBundle, sharpLayer } from './artifacts.js';
import { DERIVED_PREFIX, MASTER_PREFIX, ORIGINAL_PREFIX, STAGING_PREFIX } from './storage-stack.js';

export interface ComputeStackProps extends StackProps {
  config: EnvironmentConfig;
  bucket: s3.IBucket;
  optimizeQueue: sqs.IQueue;
}

export class ComputeStack extends Stack {
  readonly generatorFunctionUrl: lambda.FunctionUrl;
  readonly generator: lambda.Function;
  /** Exposed for alarms, which take names rather than constructs. */
  readonly optimizer: lambda.Function;
  /** The identity the Lightsail host authenticates as. */
  readonly controlPlaneUser: iam.User;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { config, bucket, optimizeQueue } = props;

    /*
     * No database configuration reaches either function.
     *
     * `WORKER_CALLBACK_URL` is the control plane, and `WORKER_CALLBACK_SECRET` is how
     * it recognises them. The secret is supplied as a plain environment value rather
     * than from Secrets Manager, which is a deliberate downgrade from what RDS had:
     * fetching it would put a Secrets Manager client back in the init path of the
     * function on the viewer's critical path, to protect a credential that grants
     * bookkeeping writes and nothing else. It rotates by redeploying both sides.
     */
    const sharedEnv = {
      NODE_ENV: 'production',
      S3_BUCKET: bucket.bucketName,
      SQS_OPTIMIZE_QUEUE_URL: optimizeQueue.queueUrl,
      CDN_HOST: config.cdnHost,
      ENCODER_EPOCH: String(config.delivery.encoderEpoch),
      WARM_WIDTHS: config.processing.warmWidths,
      WARM_FORMATS: config.processing.warmFormats,
      UPLOAD_MALWARE_SCAN_ENABLED: String(config.malwareScanning),
      WORKER_CALLBACK_URL: config.workerCallbackUrl,
      WORKER_CALLBACK_SECRET: config.workerCallbackSecret,
    };

    /*
     * Native binaries ship in a layer built for linux/arm64 in a container matching
     * the runtime, never resolved from whoever ran the deploy. A sharp binary picked
     * up from a macOS workstation produces a function that deploys cleanly and fails
     * on its first invocation. See scripts/build-sharp-layer.sh.
     */
    const sharp = new lambda.LayerVersion(this, 'SharpLayer', {
      code: lambda.Code.fromAsset(sharpLayer()),
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'sharp + libvips, built for linux/arm64',
    });

    // ---- optimizer: the eager warm set, behind a queue --------------------

    const optimizer = (this.optimizer = new lambda.Function(this, 'Optimizer', {
      functionName: `imgopt-${config.name}-optimizer`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(optimizerBundle()),
      layers: [sharp],
      memorySize: config.lambda.optimizerMemoryMb,
      timeout: config.lambda.optimizerTimeout,
      logGroup: logGroupFor(this, 'OptimizerLogs', `imgopt-${config.name}-optimizer`),
      // Control path: the optimizer runs once per upload, behind a queue.
      tracing: lambda.Tracing.ACTIVE,
      environment: sharedEnv,
    }));

    optimizer.addEventSource(
      new eventsources.SqsEventSource(optimizeQueue, {
        batchSize: 5,
        // Only genuinely retriable failures are reported back, so a corrupt source
        // is recorded and acknowledged instead of cycling to the DLQ the slow way.
        reportBatchItemFailures: true,
        /*
         * A ceiling on the poller's fan-out.
         *
         * It used to be a database-connection budget. It is now a *control plane*
         * budget, and the number means the same thing for the same reason: this
         * consumer must not be able to cure its own backlog by overwhelming the
         * single instance that also accepts uploads. A bulk import drains slightly
         * slower and the API stays up. See `optimizerMaxConcurrency` in config.ts.
         */
        maxConcurrency: config.lambda.optimizerMaxConcurrency,
      }),
    );

    // Reads originals, writes masters and derivatives. Never writes an original:
    // sources are write-once, and replacing bytes mints a new version instead.
    grantRead(optimizer, bucket, [ORIGINAL_PREFIX, MASTER_PREFIX]);
    grantWrite(optimizer, bucket, [MASTER_PREFIX, DERIVED_PREFIX]);
    grantList(optimizer, bucket, [ORIGINAL_PREFIX, DERIVED_PREFIX]);

    // ---- generator: on-miss generation, on the viewer's critical path -----

    this.generator = new lambda.Function(this, 'Generator', {
      functionName: `imgopt-${config.name}-generator`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(generatorBundle()),
      layers: [sharp],
      memorySize: config.lambda.generatorMemoryMb,
      timeout: config.lambda.generatorTimeout,
      // Caps worst-case spend when a burst of distinct uncached variants arrives —
      // a launch, a crawler, or a crafted URL sweep. Excess requests fail fast with
      // a short-lived error rather than fanning out without limit.
      reservedConcurrentExecutions: config.lambda.generatorReservedConcurrency,
      logGroup: logGroupFor(this, 'GeneratorLogs', `imgopt-${config.name}-generator`),
      // Deliberately untraced. This is the delivery path: per-request tracing at
      // CDN volume costs more than the traffic it observes, and the question worth
      // asking here — how often does this run at all — is a metric, not a trace.
      tracing: lambda.Tracing.DISABLED,
      environment: sharedEnv,
    });

    // Reads originals and masters, writes derivatives, and nothing else. It cannot
    // touch staging, cannot write an original, and cannot delete anything.
    grantRead(this.generator, bucket, [ORIGINAL_PREFIX, MASTER_PREFIX]);
    grantWrite(this.generator, bucket, [DERIVED_PREFIX]);
    // Listing is confined to originals, which is the one lookup it genuinely needs:
    // the source extension is not recoverable from a delivery path.
    grantList(this.generator, bucket, [ORIGINAL_PREFIX]);

    this.generatorFunctionUrl = this.generator.addFunctionUrl({
      // Signed by CloudFront through OAC. A public Function URL would be an
      // unmetered, unbucketed image-processing endpoint open to the internet.
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // ---- the control plane's identity -------------------------------------

    /*
     * An IAM *user*, which is a real downgrade from the Fargate task role, and not a
     * choice — Lightsail instances cannot assume a role. There is no instance profile
     * and no metadata endpoint handing out rotating credentials, so the host
     * authenticates with a long-lived access key.
     *
     * What that costs: a static credential exists, on disk, on one machine. What is
     * done about it: the policy below is the same prefix-scoped set the task role had
     * and nothing more, the key is created out of band rather than by this stack (a
     * CloudFormation-created key is readable in the template's outputs forever), and
     * rotation is a documented procedure rather than an intention. See
     * docs/operations.md.
     *
     * This is also the single strongest argument for the ECS migration in L7: moving
     * the control plane to a service that supports task roles deletes this user.
     */
    const user = (this.controlPlaneUser = new iam.User(this, 'ControlPlaneUser', {
      userName: `imgopt-${config.name}-control-plane`,
    }));

    // Owns ingest: stages, promotes, and reaps. It does not render, so it writes no
    // derivative — but it deletes across every prefix, because `DELETE /v1/images/:id`
    // removes an asset's objects wherever they live.
    grantRead(user, bucket, [STAGING_PREFIX, ORIGINAL_PREFIX, MASTER_PREFIX, DERIVED_PREFIX]);
    grantWrite(user, bucket, [STAGING_PREFIX, ORIGINAL_PREFIX]);
    grantDelete(user, bucket, [STAGING_PREFIX, ORIGINAL_PREFIX, MASTER_PREFIX, DERIVED_PREFIX]);
    grantList(user, bucket, [STAGING_PREFIX, ORIGINAL_PREFIX, MASTER_PREFIX, DERIVED_PREFIX]);
    optimizeQueue.grantSendMessages(user);

    /*
     * Metrics, and only metrics.
     *
     * `cloudwatch:PutMetricData` cannot be scoped to a namespace by resource — the
     * action takes no resource ARN — so the namespace condition is the only thing
     * between "publish our metrics" and "publish anything, including values that
     * would silence an alarm".
     */
    user.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'Imgopt' } },
      }),
    );

    new CfnOutput(this, 'GeneratorFunctionUrl', { value: this.generatorFunctionUrl.url });
    new CfnOutput(this, 'GeneratorFunctionName', { value: this.generator.functionName });
    new CfnOutput(this, 'OptimizerFunctionName', { value: optimizer.functionName });
    new CfnOutput(this, 'ControlPlaneUserName', {
      value: user.userName,
      description:
        'Create an access key for this user out of band; the stack does not, because a ' +
        'CloudFormation-created key stays readable in the template.',
    });
  }
}

/**
 * A log group owned by this stack rather than by the deprecated `logRetention`
 * property, which provisions a custom resource and a Lambda of its own to set a
 * retention policy.
 */
function logGroupFor(scope: Construct, id: string, name: string): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    logGroupName: `/aws/lambda/${name}`,
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });
}

type Grantable = iam.IGrantable;

function objectArns(bucket: s3.IBucket, prefixes: string[]): string[] {
  return prefixes.map((prefix) => bucket.arnForObjects(`${prefix}*`));
}

function grantRead(to: Grantable, bucket: s3.IBucket, prefixes: string[]): void {
  to.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectAttributes'],
      resources: objectArns(bucket, prefixes),
    }),
  );
}

function grantWrite(to: Grantable, bucket: s3.IBucket, prefixes: string[]): void {
  to.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
      resources: objectArns(bucket, prefixes),
    }),
  );
}

function grantDelete(to: Grantable, bucket: s3.IBucket, prefixes: string[]): void {
  to.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['s3:DeleteObject'],
      resources: objectArns(bucket, prefixes),
    }),
  );
}

/**
 * `s3:ListBucket` is a bucket-level action, so it cannot be scoped by resource ARN.
 * The `s3:prefix` condition is the only thing standing between "list what you need"
 * and "enumerate every original in the deployment".
 */
function grantList(to: Grantable, bucket: s3.IBucket, prefixes: string[]): void {
  to.grantPrincipal.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': prefixes.map((prefix) => `${prefix}*`) } },
    }),
  );
}
