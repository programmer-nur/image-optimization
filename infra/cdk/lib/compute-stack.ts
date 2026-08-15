/**
 * Compute stack — both Lambdas, the Fargate control plane, and the migration task.
 *
 * This is the stack that changes on every release, which is exactly why storage and
 * data are not in it. Deploying application code must never present CloudFormation
 * with the option of replacing a bucket or a database.
 *
 * IAM here is scoped by *prefix*, not by bucket. The four prefixes have four trust
 * levels, and a role that can write `original/` is a role that can rewrite history.
 */

import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  aws_lambda_event_sources as eventsources,
  type StackProps,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from './config.js';
import { generatorBundle, maintenanceBundle, optimizerBundle, sharpLayer } from './artifacts.js';
import { NetworkStack } from './network-stack.js';
import { createControlPlaneWebAcl } from './waf.js';
import { DERIVED_PREFIX, MASTER_PREFIX, ORIGINAL_PREFIX, STAGING_PREFIX } from './storage-stack.js';

export interface ComputeStackProps extends StackProps {
  config: EnvironmentConfig;
  vpc: ec2.IVpc;
  appSecurityGroup: ec2.ISecurityGroup;
  albSecurityGroup: ec2.ISecurityGroup;
  bucket: s3.IBucket;
  optimizeQueue: sqs.IQueue;
  database: rds.IDatabaseInstance;
  databaseSecret: secretsmanager.ISecret;
  databaseName: string;
  /** Regional certificate for the ALB. Absent means plain HTTP on the ALB DNS name. */
  apiCertificate?: acm.ICertificate;
}

export class ComputeStack extends Stack {
  readonly generatorFunctionUrl: lambda.FunctionUrl;
  readonly generator: lambda.Function;
  readonly service: ecs.FargateService;
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  /** Dimension value the ALB target-group metrics are published under. */
  readonly targetGroupFullName: string;
  readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const {
      config,
      vpc,
      appSecurityGroup,
      albSecurityGroup,
      bucket,
      optimizeQueue,
      database,
      databaseSecret,
      databaseName,
      apiCertificate,
    } = props;

    // Connection parts, not a URL. The host, port, user, and database name are not
    // secret; only the password is, and it is delivered from the secret store at
    // runtime rather than baked into a task definition or a template.
    const databaseEnv = {
      DB_HOST: database.dbInstanceEndpointAddress,
      DB_PORT: database.dbInstanceEndpointPort,
      DB_USER: 'imgopt',
      DB_NAME: databaseName,
    };

    const sharedEnv = {
      NODE_ENV: 'production',
      S3_BUCKET: bucket.bucketName,
      SQS_OPTIMIZE_QUEUE_URL: optimizeQueue.queueUrl,
      CDN_HOST: config.cdnHost,
      ENCODER_EPOCH: String(config.delivery.encoderEpoch),
      WARM_WIDTHS: config.processing.warmWidths,
      WARM_FORMATS: config.processing.warmFormats,
      // Must match whether the storage stack provisioned a scanner. The app fails
      // closed on a missing verdict, so claiming scanning where none exists holds
      // every upload forever.
      UPLOAD_MALWARE_SCAN_ENABLED: String(config.malwareScanning),
      ...databaseEnv,
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

    const optimizer = new lambda.Function(this, 'Optimizer', {
      functionName: `imgopt-${config.name}-optimizer`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(optimizerBundle()),
      layers: [sharp],
      memorySize: config.lambda.optimizerMemoryMb,
      timeout: config.lambda.optimizerTimeout,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [appSecurityGroup],
      logGroup: logGroupFor(this, 'OptimizerLogs', `imgopt-${config.name}-optimizer`),
      // Control path: the optimizer runs once per upload, behind a queue.
      tracing: lambda.Tracing.ACTIVE,
      environment: { ...sharedEnv, DB_SECRET_ARN: databaseSecret.secretArn },
    });

    optimizer.addEventSource(
      new eventsources.SqsEventSource(optimizeQueue, {
        batchSize: 5,
        // Only genuinely retriable failures are reported back, so a corrupt source
        // is recorded and acknowledged instead of cycling to the DLQ the slow way.
        reportBatchItemFailures: true,
      }),
    );

    // Reads originals, writes masters and derivatives. Never writes an original:
    // sources are write-once, and replacing bytes mints a new version instead.
    grantRead(optimizer, bucket, [ORIGINAL_PREFIX, MASTER_PREFIX]);
    grantWrite(optimizer, bucket, [MASTER_PREFIX, DERIVED_PREFIX]);
    grantList(optimizer, bucket, [ORIGINAL_PREFIX, DERIVED_PREFIX]);
    databaseSecret.grantRead(optimizer);

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
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [appSecurityGroup],
      logGroup: logGroupFor(this, 'GeneratorLogs', `imgopt-${config.name}-generator`),
      // Deliberately untraced. This is the delivery path: per-request tracing at
      // CDN volume costs more than the traffic it observes, and the question worth
      // asking here — how often does this run at all — is a metric, not a trace.
      tracing: lambda.Tracing.DISABLED,
      environment: { ...sharedEnv, DB_SECRET_ARN: databaseSecret.secretArn },
    });

    // Reads originals and masters, writes derivatives, and nothing else. It cannot
    // touch staging, cannot write an original, and cannot delete anything.
    grantRead(this.generator, bucket, [ORIGINAL_PREFIX, MASTER_PREFIX]);
    grantWrite(this.generator, bucket, [DERIVED_PREFIX]);
    // Listing is confined to originals, which is the one lookup it genuinely needs:
    // the source extension is not recoverable from a delivery path.
    grantList(this.generator, bucket, [ORIGINAL_PREFIX]);
    databaseSecret.grantRead(this.generator);

    this.generatorFunctionUrl = this.generator.addFunctionUrl({
      // Signed by CloudFront through OAC. A public Function URL would be an
      // unmetered, unbucketed image-processing endpoint open to the internet.
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // ---- maintenance: scheduled reclamation --------------------------------

    /*
     * No sharp layer, and deliberately so: this function moves and deletes objects
     * and never decodes one, so it needs no native binary. That also keeps it out of
     * the encoder-epoch coupling — a libvips upgrade cannot affect it.
     */
    const maintenance = new lambda.Function(this, 'Maintenance', {
      functionName: `imgopt-${config.name}-maintenance`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(maintenanceBundle()),
      memorySize: 1024,
      // Long, because a run walks the whole bucket. The per-run deletion cap, not
      // the clock, is what bounds it — a timeout mid-run simply defers work.
      timeout: Duration.minutes(15),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [appSecurityGroup],
      logGroup: logGroupFor(this, 'MaintenanceLogs', `imgopt-${config.name}-maintenance`),
      // Control path: scheduled, low volume, and worth tracing when a run misbehaves.
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        ...sharedEnv,
        DB_SECRET_ARN: databaseSecret.secretArn,
        ORPHAN_SAFETY_WINDOW_HOURS: String(config.lifecycle.orphanSafetyWindowHours),
        SUPERSEDED_RETENTION_DAYS: String(config.lifecycle.supersededRetentionDays),
        PENDING_UPLOAD_TTL_HOURS: String(config.lifecycle.pendingUploadTtlHours),
        MAX_DELETIONS_PER_RUN: String(config.lifecycle.maxDeletionsPerRun),
        MAINTENANCE_DRY_RUN: String(config.lifecycle.dryRun),
      },
    });

    /*
     * The only role in the deployment that can delete an original.
     *
     * Granted knowingly: reclaiming a superseded version means deleting its source,
     * and nothing else in the system is allowed to. Staging is included so an
     * abandoned upload's bytes can be removed; the derivative prefix so orphans can.
     */
    grantRead(maintenance, bucket, [
      STAGING_PREFIX,
      ORIGINAL_PREFIX,
      MASTER_PREFIX,
      DERIVED_PREFIX,
    ]);
    grantDelete(maintenance, bucket, [
      STAGING_PREFIX,
      ORIGINAL_PREFIX,
      MASTER_PREFIX,
      DERIVED_PREFIX,
    ]);
    grantList(maintenance, bucket, [
      STAGING_PREFIX,
      ORIGINAL_PREFIX,
      MASTER_PREFIX,
      DERIVED_PREFIX,
    ]);
    databaseSecret.grantRead(maintenance);

    new events.Rule(this, 'MaintenanceSchedule', {
      ruleName: `imgopt-${config.name}-maintenance`,
      description: 'Orphan reconciliation, superseded-version expiry, and upload reaping',
      // Daily. The windows this job enforces are measured in hours and days, so a
      // tighter schedule would only re-examine objects it already decided to keep.
      schedule: events.Schedule.rate(Duration.days(1)),
      targets: [new eventTargets.LambdaFunction(maintenance)],
    });

    // ---- control plane: Fargate behind an ALB -----------------------------

    this.repository = new ecr.Repository(this, 'ApiRepository', {
      repositoryName: `imgopt-${config.name}-api`,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 20, description: 'Keep the last 20 images' }],
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `imgopt-${config.name}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const imageTag = process.env['API_IMAGE_TAG'] ?? 'latest';
    const image = ecs.ContainerImage.fromEcrRepository(this.repository, imageTag);

    const logging = new ecs.AwsLogDriver({
      streamPrefix: 'api',
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      cpu: config.api.cpu,
      memoryLimitMiB: config.api.memoryMb,
    });

    taskDefinition.addContainer('api', {
      image,
      portMappings: [{ containerPort: NetworkStack.APP_PORT }],
      environment: { ...sharedEnv, PORT: String(NetworkStack.APP_PORT) },
      // Resolved from the secret store when the container starts. The task
      // definition carries the secret's ARN, never its value.
      secrets: { DB_PASSWORD: ecs.Secret.fromSecretsManager(databaseSecret, 'password') },
      logging,
    });

    /*
     * Tracing, on the control path only.
     *
     * The API, the queue, and the optimizer are low-volume and stateful, which is
     * exactly where a trace earns its cost: a slow upload is a question about time
     * spent across validation, storage, the database, and the enqueue.
     *
     * The generator is deliberately excluded. It sits behind the CDN at delivery
     * volume, and per-request tracing there would cost more than the traffic it
     * observes while telling us nothing a metric does not — the interesting question
     * about delivery is "how often does this run at all", not "where did this one
     * invocation spend its time". See design.md D17.
     */
    taskDefinition.addContainer('xray', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:latest'),
      essential: false,
      cpu: 32,
      memoryReservationMiB: 256,
      portMappings: [{ containerPort: 2000, protocol: ecs.Protocol.UDP }],
      logging: new ecs.AwsLogDriver({
        streamPrefix: 'xray',
        logGroup: new logs.LogGroup(this, 'XRayLogs', {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      }),
    });

    taskDefinition.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'),
    );

    this.service = new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition,
      desiredCount: config.api.desiredCount,
      securityGroups: [appSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // Rolls back automatically when a new task definition fails to stabilize,
      // rather than leaving the service stuck part-deployed.
      circuitBreaker: { rollback: true },
      // Keeps the full desired count serving during a deployment. The default of 50%
      // halves capacity mid-deploy, which on a two-task service means one task
      // absorbing all ingest traffic.
      minHealthyPercent: 100,
    });

    /*
     * The load balancer is built explicitly rather than through
     * `ApplicationLoadBalancedFargateService`.
     *
     * The pattern creates its own security group and then wires it to the task
     * group, which writes an ingress rule into whichever stack owns the task group.
     * With the task group in the network stack, that rule references a compute
     * resource from the network stack while compute already depends on network for
     * the VPC — a cycle CloudFormation refuses, reported as a wall of route-table
     * associations rather than the one line responsible.
     *
     * Both groups and the rule between them are declared in the network stack, and
     * `openListener: false` below keeps this from adding another.
     */
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ApiLoadBalancer', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = this.loadBalancer.addListener('Listener', {
      port: apiCertificate !== undefined ? 443 : 80,
      protocol: apiCertificate !== undefined ? ApplicationProtocol.HTTPS : ApplicationProtocol.HTTP,
      ...(apiCertificate !== undefined ? { certificates: [apiCertificate] } : {}),
      open: false,
    });

    if (apiCertificate !== undefined) {
      // Plain HTTP is answered only to send the client to HTTPS.
      this.loadBalancer.addRedirect({
        sourceProtocol: ApplicationProtocol.HTTP,
        sourcePort: 80,
        targetProtocol: ApplicationProtocol.HTTPS,
        targetPort: 443,
        open: false,
      });
    }

    const targetGroup = listener.addTargets('ApiTargets', {
      port: NetworkStack.APP_PORT,
      protocol: ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        // Dependency-aware: reports unhealthy when storage or the database is
        // unreachable, so a task that cannot serve is pulled from the target group.
        path: '/readyz',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(30),
    });

    this.targetGroupFullName = targetGroup.targetGroupFullName;

    /*
     * Rate limiting sits on the load balancer, not in the application.
     *
     * A per-instance limiter would give an attacker a budget that scales with the
     * service — the limit times however many tasks are running — and it would widen
     * exactly when the service is already struggling. This counts once, and rejects
     * before a request reaches a task at all.
     */
    const webAcl = createControlPlaneWebAcl(this, 'ApiWebAcl', { environment: config.name });

    new wafv2.CfnWebACLAssociation(this, 'ApiWebAclAssociation', {
      resourceArn: this.loadBalancer.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: config.api.minCapacity,
      maxCapacity: config.api.maxCapacity,
    });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 65,
      scaleInCooldown: Duration.minutes(3),
      scaleOutCooldown: Duration.minutes(1),
    });

    const taskRole = taskDefinition.taskRole;
    // The control plane owns ingest: it stages, promotes, and reaps. It does not
    // render, so it needs no write access to derivatives beyond cleanup.
    grantRead(taskRole, bucket, [STAGING_PREFIX, ORIGINAL_PREFIX, MASTER_PREFIX, DERIVED_PREFIX]);
    grantWrite(taskRole, bucket, [STAGING_PREFIX, ORIGINAL_PREFIX]);
    grantDelete(taskRole, bucket, [STAGING_PREFIX, ORIGINAL_PREFIX, MASTER_PREFIX, DERIVED_PREFIX]);
    grantList(taskRole, bucket, [STAGING_PREFIX, ORIGINAL_PREFIX, MASTER_PREFIX, DERIVED_PREFIX]);
    optimizeQueue.grantSendMessages(taskRole);
    databaseSecret.grantRead(taskRole);

    // ---- migrations: a task definition, not a container entrypoint --------

    /*
     * Migrations run as an explicit one-off task before the new version takes
     * traffic — never on container start. Several tasks starting at once would
     * otherwise race to apply the same migration, and the failure mode of that is a
     * half-migrated schema rather than a clean error.
     */
    const migrationTask = new ecs.FargateTaskDefinition(this, 'MigrationTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    migrationTask.addContainer('migrate', {
      image,
      command: ['node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'],
      environment: databaseEnv,
      secrets: { DB_PASSWORD: ecs.Secret.fromSecretsManager(databaseSecret, 'password') },
      logging: new ecs.AwsLogDriver({
        streamPrefix: 'migrate',
        // Kept longer than the application's: a migration log is the record of what
        // was applied to the schema and when.
        logGroup: new logs.LogGroup(this, 'MigrationLogs', {
          retention: logs.RetentionDays.THREE_MONTHS,
          removalPolicy: RemovalPolicy.RETAIN,
        }),
      }),
    });
    databaseSecret.grantRead(migrationTask.taskRole);

    new CfnOutput(this, 'MaintenanceFunctionName', { value: maintenance.functionName });
    new CfnOutput(this, 'GeneratorFunctionUrl', { value: this.generatorFunctionUrl.url });
    new CfnOutput(this, 'GeneratorFunctionName', { value: this.generator.functionName });
    new CfnOutput(this, 'ApiEndpoint', {
      value: this.loadBalancer.loadBalancerDnsName,
    });
    new CfnOutput(this, 'ApiRepositoryUri', { value: this.repository.repositoryUri });
    new CfnOutput(this, 'MigrationTaskDefinition', {
      value: migrationTask.taskDefinitionArn,
      description: 'Run with: aws ecs run-task --task-definition <this> --launch-type FARGATE',
    });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
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
