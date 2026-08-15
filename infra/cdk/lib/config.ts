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

  network: {
    maxAzs: number;
    /**
     * NAT gateways.
     *
     * S3 and SQS reach the private subnets through VPC endpoints, so the NAT exists
     * only for AWS APIs that have no endpoint configured. Zero is viable and cheaper
     * once every dependency is endpoint-backed, but it fails closed and obscurely —
     * a missing endpoint looks like a hang, not an error — so the default is one.
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
  },
  queue: { maxReceiveCount: 5, visibilityTimeout: Duration.minutes(6) },
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
    ...BASE,
    database: {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      allocatedStorageGb: 20,
      multiAz: false,
      backupRetention: Duration.days(3),
    },
    api: { cpu: 512, memoryMb: 1024, desiredCount: 1, minCapacity: 1, maxCapacity: 3 },
    lambda: { ...LAMBDA, generatorReservedConcurrency: 10 },
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
    ...BASE,
    database: {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      allocatedStorageGb: 100,
      multiAz: true,
      backupRetention: Duration.days(14),
    },
    api: { cpu: 1024, memoryMb: 2048, desiredCount: 2, minCapacity: 2, maxCapacity: 10 },
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
