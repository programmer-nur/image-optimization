/**
 * The deployment manifest, and the configuration of each deployment in it.
 *
 * Deployments are fully isolated — own bucket, database, distribution, domain, and
 * queues — so nothing here is shared between them and no resource name is derivable
 * from another deployment's. That isolation is the point: a staging deployment must
 * not be able to read production's data even by accident.
 *
 * That same isolation is what makes a deployment the tenant boundary. A second
 * application is a second entry in `DEPLOYMENTS`, not a second code path — see
 * openspec/changes/multi-tenancy/design.md T2. `staging` and `production` are simply
 * the first two entries; there is nothing structurally special about either, and
 * nothing in the stacks branches on their names.
 *
 * Each entry picks a *tier*, which is only a sizing profile: how large the database
 * is, how many tasks run, how far the CDN reaches. Everything that must differ per
 * deployment — hostnames, certificates, the distribution id — comes from the
 * environment, read under the deployment's own prefix first (`ACME_CDN_HOST`) and
 * falling back to the bare name (`CDN_HOST`). The fallback is what keeps the
 * single-deployment workflow unchanged; the prefix is what lets one CI configuration
 * hold several.
 *
 * This is *deployment* configuration. Transform grammar — the width ladder, quality
 * levels, encoder defaults — lives in `@imgopt/core` as constants, because those
 * values are baked into cached URLs and changing one is an encoder-epoch event
 * rather than a redeploy knob. See design.md D8.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

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
   * Pre-issued **us-east-1** certificate for the distribution.
   *
   * Always pre-issued: DNS lives in Cloudflare (design.md D18), so a DNS-validated
   * certificate cannot be created and validated inside a CloudFormation deployment —
   * the validation record has to appear in a zone CloudFormation cannot write to, and
   * the stack would block until it timed out. `infra/cloudflare` requests it, writes
   * the validation record, waits for issuance, and prints the ARN.
   *
   * Absent, the distribution serves on its own `*.cloudfront.net` name, which is what
   * lets a first deploy happen before DNS is sorted out.
   */
  cdnCertificateArn?: string;

  /**
   * Where the workers post their bookkeeping — the control plane's public base URL.
   *
   * The workers hold no database connection (design.md L2), so this is how anything
   * they do reaches the registry. Required: a worker deployed without it fails at
   * init rather than silently dropping every record it was supposed to write.
   */
  workerCallbackUrl: string;

  /**
   * Shared secret authenticating those calls.
   *
   * Supplied as an environment value on both sides. It grants bookkeeping writes and
   * nothing else — no tenant scope, no delivery access, no ability to read an asset —
   * which is what makes a plain environment variable an acceptable home for it. It
   * rotates by redeploying both halves.
   */
  workerCallbackSecret: string;

  /**
   * The Lightsail instance the control plane runs on, for its status-check alarm.
   *
   * Optional because the instance is provisioned outside CloudFormation and may not
   * exist on a first deploy. Absent means no instance alarm — which is a real gap, so
   * the observability stack says so rather than quietly skipping it.
   */
  controlPlaneInstanceName?: string;

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

  api: {
    /**
     * The image the control plane and the migration step both run.
     *
     * Required, and never `latest`. The tag is the rollback coordinate: with a mutable
     * one, "redeploy the previous version" is ambiguous — the same tag can point at
     * different bytes on two consecutive days — and the running container and the
     * migration can silently disagree about which version they are.
     *
     * Still here after the move off Fargate, because it is the same image and the same
     * rollback: `docker compose pull` a tag, or go back to the previous one.
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
     * A control-plane budget, not a throughput dial. Each invocation now posts its
     * results to the single instance that also accepts uploads, so an unbounded
     * consumer means a bulk import cures its own backlog by overwhelming the API. The
     * backlog drains slightly slower and the control plane stays up.
     *
     * It used to be a database-connection budget and the number is unchanged, because
     * the constraint is the same one wearing a different hat: one small host, shared.
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
   * Ten concurrent optimize jobs, each making two short HTTP calls to the control
   * plane, against one instance that is also serving uploads. The generator adds up to
   * its own reserved concurrency (50) in fire-and-forget POSTs that it does not wait
   * on beyond a 2s timeout.
   *
   * The old arithmetic here was about Postgres connections and is gone with them; the
   * bound is now request concurrency on a single host. Revisit with observed numbers
   * from a real deployment, not before.
   */
  optimizerMaxConcurrency: 10,
};

/**
 * Settings that must differ between deployments, resolved from the environment.
 *
 * Shared by every tier, because "which hostname" and "which certificate" are
 * properties of the deployment rather than of its size.
 */
function perDeployment(name: string, prefix: string) {
  return {
    name,
    account: requireEnv(prefix, 'CDK_ACCOUNT'),
    region: readEnv(prefix, 'CDK_REGION') ?? 'us-east-1',
    cdnHost: requireEnv(prefix, 'CDN_HOST'),
    workerCallbackUrl: requireEnv(prefix, 'WORKER_CALLBACK_URL'),
    workerCallbackSecret: requireEnv(prefix, 'WORKER_CALLBACK_SECRET'),
    ...optional('controlPlaneInstanceName', readEnv(prefix, 'CONTROL_PLANE_INSTANCE_NAME')),
    ...optional('apiHost', readEnv(prefix, 'API_HOST')),
    ...optional('cdnCertificateArn', readEnv(prefix, 'CDN_CERTIFICATE_ARN')),

    ...optional('cdnDistributionId', readEnv(prefix, 'CDN_DISTRIBUTION_ID')),
    ...optional('privateDeliveryPublicKey', readEnv(prefix, 'PRIVATE_DELIVERY_PUBLIC_KEY')),
  };
}

/**
 * Sizing profiles.
 *
 * A tier says how big a deployment is, never who it is for. Adding an application
 * picks one of these; it does not add one.
 */
const TIERS = {
  /** Small, single-AZ, cheap. Suitable for a pre-production or low-volume deployment. */
  staging: (name: string, prefix: string): EnvironmentConfig => ({
    ...perDeployment(name, prefix),
    ...BASE,
    api: { imageTag: requireImageTag(prefix) },
    // A smaller instance absorbs less, so the optimizer's fan-out onto it shrinks
    // with it. The number is a control-plane budget now rather than a connection
    // budget, but it is bounded by the same thing: one host.
    lambda: { ...LAMBDA, generatorReservedConcurrency: 10, optimizerMaxConcurrency: 5 },
    delivery: { priceClass: cloudfront.PriceClass.PRICE_CLASS_100, encoderEpoch: 1 },
    // Charged per gigabyte scanned; off by default on this tier unless a change to
    // the upload path is being exercised.
    malwareScanning: readEnv(prefix, 'MALWARE_SCANNING') === 'true',
    // This tier still retains: losing its data mid-investigation is exactly when it
    // matters, and an empty-bucket redeploy is cheap to do deliberately.
    removalPolicy: RemovalPolicy.RETAIN,
  }),

  /** Multi-AZ, global price class, malware scanning on unless explicitly disabled. */
  production: (name: string, prefix: string): EnvironmentConfig => ({
    ...perDeployment(name, prefix),
    ...BASE,
    api: { imageTag: requireImageTag(prefix) },
    lambda: LAMBDA,
    delivery: { priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL, encoderEpoch: 1 },
    malwareScanning: readEnv(prefix, 'MALWARE_SCANNING') !== 'false',
    removalPolicy: RemovalPolicy.RETAIN,
  }),
} satisfies Record<string, (name: string, prefix: string) => EnvironmentConfig>;

export type Tier = keyof typeof TIERS;

export interface DeploymentEntry {
  /**
   * The deployment's identity.
   *
   * Every resource is prefixed with it, the bucket name is derived from it, and it is
   * the isolation boundary — so it is effectively permanent once anything is stored.
   * Renaming one is a migration, not an edit.
   */
  name: string;

  /** Which sizing profile to build from. */
  tier: Tier;

  /**
   * Environment-variable prefix for this deployment's own settings.
   *
   * Defaults to the upper-cased name, so `acme` reads `ACME_CDN_HOST` and falls back
   * to `CDN_HOST`. Set it explicitly only to keep an existing variable name working.
   */
  envPrefix?: string;
}

/**
 * The manifest. **Adding an application is adding an entry here.**
 *
 * Everything downstream — stacks, alarms, the bucket name, the queue names — is
 * derived from the entry, so onboarding does not touch any other file. What it *does*
 * require is the out-of-band work a deployment always needs: two certificates, two
 * Cloudflare records, and the environment variables named above. See
 * docs/bootstrap.md.
 *
 * Every entry resolves the same way — prefixed name first, bare name second — so
 * `staging` and `production` keep working from the bare `CDN_HOST`/`CDK_ACCOUNT` they
 * have always used, and this refactor changes no existing deployment procedure. The
 * bare fallback is per-invocation, though: a deploy resolves one entry, so it is only
 * `resolveAllDeployments` that sees several entries sharing one value and objects.
 */
export const DEPLOYMENTS: DeploymentEntry[] = [
  { name: 'staging', tier: 'staging' },
  { name: 'production', tier: 'production' },
  /*
   * A second application, sharing the AWS account and nothing else.
   *
   * Present rather than commented out so it is *synthesized* by the test suite: a
   * manifest whose second entry has never been built is a claim, and the resource
   * collisions this design has to avoid — a duplicate bucket name, a reused export
   * name, a stack id that already exists — are all synth-time errors that only appear
   * when two entries exist at once.
   */
  { name: 'demo', tier: 'staging' },
];

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
function requireImageTag(prefix: string): string {
  const tag = requireEnv(prefix, 'API_IMAGE_TAG');
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
 * Reads a setting for one deployment, preferring its own prefix.
 *
 * `ACME_CDN_HOST` wins over `CDN_HOST`. The fallback is what keeps a single-deployment
 * account working with the plain variable names, and it is also the sharp edge: two
 * deployments in one process with no prefixed values both read the same host. That is
 * caught by `resolveAllDeployments`, not by hoping nobody does it.
 */
function readEnv(prefix: string, key: string): string | undefined {
  const value = (prefix === '' ? undefined : process.env[`${prefix}_${key}`]) ?? process.env[key];
  return value === '' ? undefined : value;
}

/**
 * Fails at synth rather than at deploy.
 *
 * A missing account or hostname surfaces as a named error before CloudFormation is
 * involved, instead of as a half-created stack that has to be rolled back.
 */
function requireEnv(prefix: string, key: string): string {
  const value = readEnv(prefix, key);
  if (value === undefined) {
    throw new Error(
      `Missing required environment variable ${prefix === '' ? key : `${prefix}_${key} (or ${key})`}. ` +
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

function deploymentNames(): string {
  return DEPLOYMENTS.map((d) => d.name).join(', ');
}

/** The prefix an entry reads its settings under. */
function prefixFor(entry: DeploymentEntry): string {
  return entry.envPrefix ?? entry.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export function resolveEnvironment(name: string | undefined): EnvironmentConfig {
  if (name === undefined) {
    throw new Error(`No deployment selected. Pass -c env=<name>, one of: ${deploymentNames()}.`);
  }

  const entry = DEPLOYMENTS.find((d) => d.name === name);
  if (entry === undefined) {
    throw new Error(`Unknown deployment "${name}". Expected one of: ${deploymentNames()}.`);
  }
  return TIERS[entry.tier](entry.name, prefixFor(entry));
}

/**
 * Every deployment at once, with the collisions that only exist across entries.
 *
 * A deploy resolves one entry, so nothing in the normal path can see two deployments
 * claiming the same hostname — and CloudFront reports that as `CNAMEAlreadyExists`
 * during the *second* deployment, after the first has already been created. Checking
 * here turns it into a synth-time error naming both entries.
 *
 * Bucket names cannot collide by construction (they are derived from `name`, which is
 * the manifest's key), and that is asserted rather than assumed: it is the invariant
 * the whole isolation story rests on.
 */
export function resolveAllDeployments(): EnvironmentConfig[] {
  const configs = DEPLOYMENTS.map((entry) => TIERS[entry.tier](entry.name, prefixFor(entry)));

  const seenHosts = new Map<string, string>();
  const seenBuckets = new Map<string, string>();

  for (const config of configs) {
    const host = seenHosts.get(config.cdnHost);
    if (host !== undefined) {
      throw new Error(
        `Deployments "${host}" and "${config.name}" both claim the CDN hostname ` +
          `${config.cdnHost}. Each deployment needs its own; set ` +
          `${config.name.toUpperCase()}_CDN_HOST.`,
      );
    }
    seenHosts.set(config.cdnHost, config.name);

    const bucket = bucketNameFor(config);
    const owner = seenBuckets.get(bucket);
    if (owner !== undefined) {
      throw new Error(`Deployments "${owner}" and "${config.name}" derive the same bucket name.`);
    }
    seenBuckets.set(bucket, config.name);
  }

  return configs;
}
