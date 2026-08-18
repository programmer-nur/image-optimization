/**
 * Per-environment deployment configuration.
 *
 * Environments are fully isolated — own bucket, database, distribution, domain, and
 * queues — so nothing here is shared between them and no resource name is derivable
 * from another environment's. That isolation is the point: a staging deployment must
 * not be able to read production's data even by accident.
 *
 * This is *deployment* configuration. Transform grammar — the width ladder, quality
 * levels, encoder defaults — lives in `@imgopt/core` as constants, because those
 * values are baked into cached URLs and changing one is an encoder-epoch event
 * rather than a redeploy knob. See design.md D8.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export interface EnvironmentConfig {
  /** Short name; every resource is prefixed with it. */
  name: string;
  account: string;
  region: string;

  /** Public delivery hostname. Generated URLs never expose the distribution's own. */
  cdnHost: string;
  /** Public control-plane hostname. Optional: the ALB DNS name works without it. */
  apiHost?: string;

  /**
   * Hosted zone for both records, when DNS is in this account.
   *
   * Supplied explicitly rather than looked up: a `fromLookup` needs credentials at
   * synth time, which would make `cdk synth` — and therefore CI — unable to run
   * without an AWS account. When absent, the deployment still succeeds and emits the
   * records to create by hand instead of failing silently.
   */
  hostedZoneId?: string;
  hostedZoneName?: string;

  /**
   * Pre-issued us-east-1 certificate for the distribution. When absent, one is
   * issued in a us-east-1 stack, which requires `hostedZoneId` for validation.
   */
  cdnCertificateArn?: string;

  /**
   * Pre-issued certificate for the load balancer, in the deployment's own region.
   *
   * The regional counterpart to `cdnCertificateArn`, and genuinely a second
   * certificate: CloudFront accepts a viewer certificate only from us-east-1, and an
   * ALB accepts one only from its own region. Substituting one for the other fails
   * when CloudFormation tries to attach it, not at synth.
   *
   * When absent, one is issued for `apiHost` provided the hosted zone is in this
   * account. Production refuses to synthesize with neither — see ComputeStack.
   */
  apiCertificateArn?: string;

  /**
   * This environment's distribution id, pinning the bucket's read grant to it.
   *
   * Supplied out of band rather than referenced: naming the CDN stack's construct
   * here would make storage depend on CDN, which depends on compute, which depends on
   * storage. Without it the grant admits any distribution in the account, so a
   * staging distribution can read production's derivatives — the one place the
   * per-environment isolation everything else here relies on does not hold.
   *
   * First deploy of an environment runs without it; take `DistributionId` from the
   * CDN stack's outputs, set `CDN_DISTRIBUTION_ID`, and redeploy storage.
   */
  cdnDistributionId?: string;

  network: {
    maxAzs: number;
    /**
     * NAT gateways.
     *
     * S3 and SQS reach the private subnets through VPC endpoints, so the NAT exists
     * only for AWS APIs that have no endpoint configured. Zero is viable and cheaper
     * once every dependency is endpoint-backed, but it fails closed and obscurely —
     * a missing endpoint looks like a hang, not an error — so the default is one.
     *
     * The residual, stated so it is priced deliberately rather than discovered: one
     * NAT gateway lives in one availability zone, and everything not endpoint-backed
     * goes through it — including ECR image pulls for task launches, X-Ray, and STS.
     * Losing that zone costs egress and new task launches for the survivors, not just
     * the tasks in it. Two NATs in production is one line and roughly one extra
     * hourly charge; it is deliberately not taken by default because the endpoints
     * already keep the hot paths off it.
     */
    natGateways: number;
  };

  storage: {
    /** Age at which originals move to infrequent access. Derivatives never move. */
    originalsInfrequentAccessDays: number;
    /** Age at which originals move to instant-retrieval archival. */
    originalsArchiveDays: number;
    /** Untrusted uploads are short-lived by policy, not by convention. */
    stagingExpiryDays: number;
    abortIncompleteMultipartDays: number;
    /**
     * How long a replaced or deleted object survives as a noncurrent version.
     *
     * The bucket is versioned, so a delete does not destroy bytes — it writes a
     * delete marker and keeps the old copy. That is the point for originals: a defect
     * in reclamation becomes recoverable instead of permanent. It is also why this
     * number exists at all, since without an expiry the recovery copies accumulate
     * forever and reclamation stops reducing the bill.
     */
    noncurrentVersionExpiryDays: number;
    /**
     * The same window for `staging/`, and deliberately much shorter.
     *
     * Staging holds unvalidated bytes, including whatever a malware scan is about to
     * reject. Under versioning both the hard expiry rule and the quarantine handler's
     * delete leave the original copy behind as a noncurrent version — so a window
     * sized for "recover a deleted original" would silently become "retain flagged
     * malware for a month".
     */
    stagingNoncurrentExpiryDays: number;
    /**
     * How long access logs are kept.
     *
     * Long enough to investigate something noticed weeks later, short enough that the
     * log bucket does not become a storage tier of its own — it is the one line that
     * grows with traffic rather than with content.
     */
    accessLogRetentionDays: number;
  };

  database: {
    instanceType: ec2.InstanceType;
    allocatedStorageGb: number;
    multiAz: boolean;
    backupRetention: Duration;
  };

  api: {
    cpu: number;
    memoryMb: number;
    desiredCount: number;
    minCapacity: number;
    maxCapacity: number;
    /**
     * The image the service and the migration task both run.
     *
     * Required, and never `latest`. The tag is the rollback coordinate: with a
     * mutable one, "redeploy the previous version" is ambiguous — the same tag can
     * point at different bytes on two consecutive days — and the service and the
     * migration task can silently disagree about which version they are.
     */
    imageTag: string;
  };

  lambda: {
    optimizerMemoryMb: number;
    optimizerTimeout: Duration;
    generatorMemoryMb: number;
    generatorTimeout: Duration;
    /**
     * Caps worst-case spend when a burst of distinct uncached variants arrives.
     * Excess requests fail fast with a short-lived error rather than fanning out.
     */
    generatorReservedConcurrency: number;
    /**
     * Ceiling on how many optimizer invocations SQS may run at once.
     *
     * This is a database-connection budget, not a throughput dial. Each optimizer
     * invocation opens its own Postgres connection (the Lambda client is pinned to a
     * pool of one), and it shares one small instance with the control plane — so an
     * unbounded consumer means a bulk import can cure its own backlog by exhausting
     * the connections the API needs to accept uploads. The backlog drains slightly
     * slower and the control plane stays up.
     *
     * Event-source concurrency rather than reserved concurrency on the function:
     * reserved concurrency permanently carves capacity out of the account pool, which
     * is right for the generator (it is the viewer path, and its cap exists to bound
     * spend) and wrong here, where the only thing being protected is the database.
     */
    optimizerMaxConcurrency: number;
  };

  queue: {
    /** Attempts before a message is dead-lettered. */
    maxReceiveCount: number;
    visibilityTimeout: Duration;
  };

  delivery: {
    priceClass: cloudfront.PriceClass;
    /**
     * Bumping this mints a fresh URL space for every asset at once, with no
     * per-asset write and no invalidation. See design.md D8.
     */
    encoderEpoch: number;
  };

  processing: {
    warmWidths: string;
    warmFormats: string;
  };

  /**
   * Provision GuardDuty Malware Protection on the staging prefix.
   *
   * Must match `UPLOAD_MALWARE_SCAN_ENABLED` on the control plane, which this stack
   * sets from the same value. Enabling one without the other is the trap: the app
   * fails closed on a missing verdict, so turning the app flag on without a scanner
   * holds every upload forever.
   */
  malwareScanning: boolean;

  /**
   * PEM public key enabling signed-URL delivery for private assets.
   *
   * Absent means the feature is off entirely and no extra cache behavior exists.
   * Only the public half goes to CloudFront; the control plane signs with the private
   * half, which lives in the secret store and never in this configuration.
   */
  privateDeliveryPublicKey?: string;

  /**
   * Windows the scheduled maintenance worker enforces.
   *
   * Passed through to the function as environment, so the deployed values and the
   * ones reviewed here are the same values. Each is a *safety* margin rather than a
   * tuning knob — shortening one makes reclamation race the system it cleans up
   * after, and the objects at stake include originals.
   */
  lifecycle: {
    orphanSafetyWindowHours: number;
    supersededRetentionDays: number;
    pendingUploadTtlHours: number;
    maxDeletionsPerRun: number;
    /** How long an asset may sit unoptimized before its job is queued again. */
    stalledOptimizeHours: number;
    maxReenqueuesPerRun: number;
    dryRun: boolean;
  };

  observability: {
    /**
     * Sustained on-demand generations per 15 minutes before alarming.
     *
     * Not zero: new assets and new variants legitimately generate. The alarm is
     * looking for a *plateau*, so this is set above normal introduction rate and
     * evaluated over several consecutive periods.
     */
    onDemandGenerationsPer15Min: number;
    /** Regenerations of keys that already existed. Near-zero is the only healthy value. */
    redundantGenerationsPer15Min: number;
    queueAgeSeconds: number;
    generationFailurePercent: number;
    cacheHitRatePercent: number;
    apiServerErrorsPer5Min: number;
    /** Runtime-level Lambda failures per 5 minutes: init, OOM, timeout, crash. */
    lambdaErrorsPer5Min: number;
    /** CloudFront 5xx as a percentage of requests. */
    cdnServerErrorPercent: number;
  };

  /** Retain on stateful stacks everywhere; only a throwaway environment differs. */
  removalPolicy: RemovalPolicy;
}

const BASE = {
  network: { maxAzs: 2, natGateways: 1 },
  storage: {
    originalsInfrequentAccessDays: 30,
    originalsArchiveDays: 180,
    stagingExpiryDays: 1,
    abortIncompleteMultipartDays: 1,
    // Long enough to notice that something was deleted that should not have been —
    // a maintenance run happens daily, and a broken image is usually reported within
    // days — and short enough that recovery copies do not become a storage tier of
    // their own.
    noncurrentVersionExpiryDays: 30,
    // One day: unvalidated bytes get no recovery window worth the name.
    stagingNoncurrentExpiryDays: 1,
    accessLogRetentionDays: 90,
  },
  /*
   * Visibility must be about six times the consumer's timeout, not merely greater.
   *
   * The clock starts when the poller receives the batch, not when the function
   * starts, so a batch that runs to the optimizer's own 5-minute timeout would be
   * redelivered while the first attempt's writes were still landing. The work is
   * idempotent, so the cost is not corruption — it is burnt receives: five of them
   * dead-letter a message that never actually failed, and the DLQ alarm then reports
   * a problem that does not exist while hiding one that might.
   *
   * The resulting envelope is 5 receives x 30 minutes = 2.5 hours worst case in
   * flight, comfortably inside the queue's 4-day retention. Do not instead shorten
   * the optimizer's timeout: 5 minutes is sized for the warm set on a large source,
   * and shortening it trades a rare redelivery for a real failure.
   */
  queue: { maxReceiveCount: 5, visibilityTimeout: Duration.minutes(30) },
  processing: { warmWidths: '1080', warmFormats: 'avif' },
  lifecycle: {
    // A full day. The generator writes a derivative before its bookkeeping row
    // exists, and that row is best-effort — so anything shorter risks reclaiming an
    // object that is live but not yet recorded.
    orphanSafetyWindowHours: 24,
    // Long enough that consumer HTML referencing the previous version's URLs has
    // cycled out of browser and CDN caches.
    supersededRetentionDays: 30,
    pendingUploadTtlHours: 24,
    maxDeletionsPerRun: 10_000,
    // Clear of SQS's own retry ceiling (visibility timeout x maxReceiveCount), so
    // re-enqueueing never races a redelivery that is still in flight.
    stalledOptimizeHours: 6,
    maxReenqueuesPerRun: 500,
    dryRun: false,
  },
  observability: {
    onDemandGenerationsPer15Min: 500,
    // Deliberately tight. A handful can come from concurrent first requests racing;
    // a steady stream has exactly one cause, and it is drift.
    redundantGenerationsPer15Min: 20,
    queueAgeSeconds: 900,
    generationFailurePercent: 5,
    cacheHitRatePercent: 80,
    apiServerErrorsPer5Min: 10,
    // Runtime-level failures — init errors, OOM kills, timeouts — which the
    // handler-emitted metrics structurally cannot report, because the handler did
    // not run.
    lambdaErrorsPer5Min: 5,
    // A percentage, not a count: CloudFront publishes 5xx as a rate.
    cdnServerErrorPercent: 1,
  },
} as const;

/**
 * Lambda sizing.
 *
 * Memory is the only performance dial on Lambda — CPU scales with it — so these are
 * starting points to be replaced by measurements from Lambda Power Tuning (task
 * 14.7), not guesses to keep. The generator gets more memory than the optimizer
 * because its latency is user-visible: a miss blocks a viewer, while the optimizer
 * runs behind a queue where nobody is waiting.
 */
const LAMBDA = {
  optimizerMemoryMb: 2048,
  optimizerTimeout: Duration.minutes(5),
  generatorMemoryMb: 3008,
  generatorTimeout: Duration.seconds(30),
  generatorReservedConcurrency: 50,
  /*
   * Sized against the database, with the arithmetic written down because the number
   * looks arbitrary otherwise.
   *
   * One connection per concurrent invocation. Production budget: the API can hold up
   * to 10 connections per task across 10 tasks (100), the generator's own bookkeeping
   * writes can add up to its reserved concurrency (50), and a `t4g.small`'s default
   * `max_connections` is around 225. 100 + 50 + 10 fits with room to spare. Staging
   * overrides this to 5 against a `t4g.micro` (~112).
   *
   * Revisit after 13.7 with observed numbers, not before.
   */
  optimizerMaxConcurrency: 10,
};

export const ENVIRONMENTS: Record<string, () => EnvironmentConfig> = {
  staging: () => ({
    name: 'staging',
    account: requireEnv('CDK_ACCOUNT'),
    region: process.env['CDK_REGION'] ?? 'us-east-1',
    cdnHost: requireEnv('CDN_HOST'),
    ...optional('apiHost', process.env['API_HOST']),
    ...optional('hostedZoneId', process.env['HOSTED_ZONE_ID']),
    ...optional('hostedZoneName', process.env['HOSTED_ZONE_NAME']),
    ...optional('cdnCertificateArn', process.env['CDN_CERTIFICATE_ARN']),
    ...optional('apiCertificateArn', process.env['API_CERTIFICATE_ARN']),
    ...optional('cdnDistributionId', process.env['CDN_DISTRIBUTION_ID']),
    ...BASE,
    database: {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      allocatedStorageGb: 20,
      multiAz: false,
      backupRetention: Duration.days(3),
    },
    api: {
      cpu: 512,
      memoryMb: 1024,
      desiredCount: 1,
      minCapacity: 1,
      maxCapacity: 3,
      imageTag: requireImageTag(),
    },
    // A t4g.micro allows roughly half the connections of a small, and staging's API
    // holds fewer — so the consumer's share shrinks with it.
    lambda: { ...LAMBDA, generatorReservedConcurrency: 10, optimizerMaxConcurrency: 5 },
    delivery: { priceClass: cloudfront.PriceClass.PRICE_CLASS_100, encoderEpoch: 1 },
    // Charged per gigabyte scanned; off in staging unless a change to the upload
    // path is being exercised.
    malwareScanning: process.env['MALWARE_SCANNING'] === 'true',
    ...optional('privateDeliveryPublicKey', process.env['PRIVATE_DELIVERY_PUBLIC_KEY']),
    // Staging still retains: losing its data mid-investigation is exactly when it
    // matters, and an empty-bucket redeploy is cheap to do deliberately.
    removalPolicy: RemovalPolicy.RETAIN,
  }),

  production: () => ({
    name: 'production',
    account: requireEnv('CDK_ACCOUNT'),
    region: process.env['CDK_REGION'] ?? 'us-east-1',
    cdnHost: requireEnv('CDN_HOST'),
    ...optional('apiHost', process.env['API_HOST']),
    ...optional('hostedZoneId', process.env['HOSTED_ZONE_ID']),
    ...optional('hostedZoneName', process.env['HOSTED_ZONE_NAME']),
    ...optional('cdnCertificateArn', process.env['CDN_CERTIFICATE_ARN']),
    ...optional('apiCertificateArn', process.env['API_CERTIFICATE_ARN']),
    ...optional('cdnDistributionId', process.env['CDN_DISTRIBUTION_ID']),
    ...BASE,
    database: {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      allocatedStorageGb: 100,
      multiAz: true,
      backupRetention: Duration.days(14),
    },
    api: {
      cpu: 1024,
      memoryMb: 2048,
      desiredCount: 2,
      minCapacity: 2,
      maxCapacity: 10,
      imageTag: requireImageTag(),
    },
    lambda: LAMBDA,
    delivery: { priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL, encoderEpoch: 1 },
    malwareScanning: process.env['MALWARE_SCANNING'] !== 'false',
    ...optional('privateDeliveryPublicKey', process.env['PRIVATE_DELIVERY_PUBLIC_KEY']),
    removalPolicy: RemovalPolicy.RETAIN,
  }),
};

/** Omits the key entirely when unset, so `exactOptionalPropertyTypes` holds. */
function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value === undefined || value === '' ? {} : { [key]: value };
}

/**
 * The control-plane image tag, required and never mutable.
 *
 * `latest` is refused rather than defaulted to. A release is defined by an image tag
 * (docs/release.md), and a rollback is "redeploy the previous tag" — which means
 * nothing if the tag can be repointed. It also lets the service and the migration
 * task, which take the tag from the same place, end up running different bytes.
 */
function requireImageTag(): string {
  const tag = requireEnv('API_IMAGE_TAG');
  if (tag === 'latest') {
    throw new Error(
      'API_IMAGE_TAG must name an immutable tag, not "latest". The tag is the ' +
        'rollback coordinate: a mutable one makes "redeploy the previous version" ' +
        'ambiguous. Tag by commit, e.g. API_IMAGE_TAG=v1 or the short SHA.',
    );
  }
  return tag;
}

/**
 * Fails at synth rather than at deploy.
 *
 * A missing account or hostname surfaces as a named error before CloudFormation is
 * involved, instead of as a half-created stack that has to be rolled back.
 */
function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable ${key}. ` +
        'See infra/cdk/README.md for the full list.',
    );
  }
  return value;
}

/**
 * The bucket name, computed rather than referenced.
 *
 * Deterministic on purpose: the CDN stack imports the bucket by this name instead of
 * taking the construct. Passing the construct would make CDK attach the origin
 * access control policy to the bucket in the storage stack, and that policy
 * references the distribution — so storage would depend on CDN, CDN on compute, and
 * compute on storage. A cycle CloudFormation rejects, reported as an unreadable list
 * of unrelated resources. The read grant is written explicitly in the storage stack
 * instead; see `StorageStack`.
 */
export function bucketNameFor(config: EnvironmentConfig): string {
  return `imgopt-${config.name}-${config.account}-${config.region}`;
}

export function resolveEnvironment(name: string | undefined): EnvironmentConfig {
  if (name === undefined) {
    throw new Error(
      `No environment selected. Pass -c env=<name>, one of: ${Object.keys(ENVIRONMENTS).join(', ')}.`,
    );
  }

  const factory = ENVIRONMENTS[name];
  if (factory === undefined) {
    throw new Error(
      `Unknown environment "${name}". Expected one of: ${Object.keys(ENVIRONMENTS).join(', ')}.`,
    );
  }
  return factory();
}
