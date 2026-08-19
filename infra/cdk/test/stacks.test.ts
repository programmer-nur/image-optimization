/**
 * Synthesis assertions.
 *
 * There is no AWS account in this loop, so these are the strongest guarantee
 * available: the app synthesizes, and the handful of properties whose failure modes
 * are silent or expensive are actually in the template. They are chosen for that
 * reason rather than for coverage — asserting every property would just restate the
 * stack definitions in a second, equally wrong-able form.
 *
 * The ones that earn their place:
 *
 * - failover on 403, because with OAC and no list permission S3 reports a missing
 *   key as 403, and getting this wrong shows viewers an access-denied error instead
 *   of an image, only for variants nobody has requested yet
 * - a path-only cache key, because including query strings silently restores the
 *   unbounded key space the whole design exists to close
 * - retention on stateful resources, because that failure is unrecoverable
 * - prefix-scoped IAM, because a role that can write `original/` can rewrite history
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { METRICS } from '@imgopt/metrics';
import {
  DEPLOYMENTS,
  bucketNameFor,
  resolveAllDeployments,
  resolveEnvironment,
  type EnvironmentConfig,
} from '../lib/config.js';
import { StorageStack } from '../lib/storage-stack.js';
import { QueueStack } from '../lib/queue-stack.js';
import { ComputeStack } from '../lib/compute-stack.js';
import { CdnStack } from '../lib/cdn-stack.js';
import { ObservabilityStack } from '../lib/observability-stack.js';

/** Any well-formed RSA public key; CloudFront validates the format, not this one. */
const TEST_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtestkeyfortemplateassertions',
  '-----END PUBLIC KEY-----',
].join('\n');

/**
 * Stands in for the real build artifacts, in a temporary directory.
 *
 * Temporary, and that is the whole point. The stub has to be named `index.mjs`,
 * because `artifacts.ts` asserts that name so an ESM bundle written to a bare `.js`
 * fails at synth rather than at every invocation of the deployed function. But that
 * is also exactly the filename the real bundler emits — so writing the stub into each
 * app's `dist-bundle` directory replaced a real build with a 30-byte comment, and
 * `pnpm test` after `build:bundles` produced a deploy that succeeded and shipped empty
 * functions.
 *
 * `IMGOPT_ARTIFACT_ROOT` points the resolver somewhere disposable instead, so the two
 * can never collide regardless of what order anyone runs things in.
 */
function stubArtifacts(): void {
  const root = mkdtempSync(join(tmpdir(), 'imgopt-synth-'));
  process.env['IMGOPT_ARTIFACT_ROOT'] = root;

  // Two, not three. Reclamation is no longer a Lambda — it ships inside the API image
  // and runs on the control-plane host (design.md L2).
  for (const app of ['optimizer', 'generator']) {
    const dir = join(root, 'apps', app, 'dist-bundle');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.mjs'), '// synthesis stub\n');
  }

  const layer = join(root, 'layers', 'sharp');
  mkdirSync(layer, { recursive: true });
  writeFileSync(join(layer, '.synth-placeholder'), 'synthesis stub\n');
}

interface Synthesized {
  config: EnvironmentConfig;
  storage: Template;
  queue: Template;
  compute: Template;
  cdn: Template;
  observability: Template;
}

/**
 * @param overrides Environment values applied after the defaults. An explicit
 *   `undefined` deletes the key — which is the only way to test a guard that fires on
 *   a *missing* variable, since the defaults below would otherwise put it straight
 *   back and the test would silently assert nothing.
 */
function synthesize(
  environment: string,
  overrides: Record<string, string | undefined> = {},
): Synthesized {
  Object.assign(process.env, {
    CDK_ACCOUNT: '123456789012',
    CDK_REGION: 'us-east-1',
    CDN_HOST: 'images.example.com',
    API_HOST: 'api.example.com',
    // Required in every environment: the tag is the rollback coordinate, and config
    // refuses both an absent one and `latest`.
    API_IMAGE_TAG: 'v-test',
    // ARNs, because nothing issues certificates any more: DNS is in Cloudflare, so
    // validation cannot happen inside a deployment. Production refuses to synthesize
    // without the API one.
    CDN_CERTIFICATE_ARN:
      'arn:aws:acm:us-east-1:123456789012:certificate/22222222-3333-4444-5555-666666666666',
    // The third manifest entry's own hostname. Deployments cannot share one, so
    // `demo` needs a prefixed value; everything else it needs falls back to the
    // shared defaults above, which is exactly the intended onboarding shape.
    DEMO_CDN_HOST: 'images.demo.example.com',
    // Where the workers post their bookkeeping. Required on every deployment: a
    // worker without it holds no route to the registry at all.
    WORKER_CALLBACK_URL: 'https://api.example.com',
    WORKER_CALLBACK_SECRET: 'test-worker-secret',
    CONTROL_PLANE_INSTANCE_NAME: 'imgopt-test-control-plane',
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const config = resolveEnvironment(environment);
  // Exercise the optional security features rather than synthesizing them away.
  config.malwareScanning = true;
  config.privateDeliveryPublicKey = TEST_PUBLIC_KEY;
  const app = new App();
  const env = { account: config.account, region: config.region };

  const storage = new StorageStack(app, 'Storage', { env, config });
  const queue = new QueueStack(app, 'Queue', { env, config });
  const compute = new ComputeStack(app, 'Compute', {
    env,
    config,
    bucket: storage.bucket,
    optimizeQueue: queue.optimizeQueue,
  });
  const cdn = new CdnStack(app, 'Cdn', {
    env,
    config,
    generatorFunctionUrl: compute.generatorFunctionUrl,
  });

  const observability = new ObservabilityStack(app, 'Observability', {
    env,
    config,
    optimizeQueueName: queue.optimizeQueue.queueName,
    deadLetterQueueName: queue.deadLetterQueue.queueName,
    generatorFunctionName: compute.generator.functionName,
    optimizerFunctionName: compute.optimizer.functionName,
    distributionId: cdn.distribution.distributionId,
  });

  return {
    config,
    observability: Template.fromStack(observability),
    storage: Template.fromStack(storage),
    queue: Template.fromStack(queue),
    compute: Template.fromStack(compute),
    cdn: Template.fromStack(cdn),
  };
}

/**
 * `findResources` is typed as `any`, which the type-checked lint rules reject and
 * which would silently swallow a typo in a property name. Everything below goes
 * through these instead.
 */
interface CfnResource {
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
}

function found(template: Template, type: string): Record<string, CfnResource> {
  return template.findResources(type);
}

function resourcesOf(template: Template, type: string): CfnResource[] {
  return Object.values(found(template, type));
}

function entriesOf(template: Template, type: string): Array<[string, CfnResource]> {
  return Object.entries(found(template, type));
}

function propertyOf<T>(resource: CfnResource | undefined, key: string): T {
  return resource?.Properties?.[key] as T;
}

/**
 * The asset bucket, selected by name rather than by position.
 *
 * The storage stack holds more than one bucket, and `[0]` is whichever CDK happened
 * to emit first — so a positional lookup silently retargets the moment another bucket
 * is added, and a lifecycle assertion starts passing against the wrong resource.
 */
function assetBucket(): CfnResource {
  const bucket = resourcesOf(app.storage, 'AWS::S3::Bucket').find(
    (candidate) => propertyOf<string>(candidate, 'BucketName') === bucketNameFor(app.config),
  );
  if (bucket === undefined) throw new Error('no asset bucket in the storage template');
  return bucket;
}

/** The asset bucket's policy, selected the same way and for the same reason. */
function assetBucketPolicy(): CfnResource {
  const entry = entriesOf(app.storage, 'AWS::S3::BucketPolicy').find(([logicalId]) =>
    logicalId.includes('AssetBucket'),
  );
  if (entry === undefined) throw new Error('no asset bucket policy in the storage template');
  return entry[1];
}

let app: Synthesized;

beforeAll(() => {
  stubArtifacts();
  app = synthesize('production');
});

describe('the app synthesizes', () => {
  it('produces every stack', () => {
    for (const template of [app.storage, app.queue, app.compute, app.cdn, app.observability]) {
      const json = template.toJSON() as { Resources: Record<string, unknown> };
      expect(Object.keys(json.Resources).length).toBeGreaterThan(0);
    }
  });

  it('synthesizes every deployment in the manifest', () => {
    for (const entry of DEPLOYMENTS) {
      expect(() => synthesize(entry.name), `${entry.name} failed to synthesize`).not.toThrow();
    }
  });
});

/*
 * The manifest, as a deployment boundary (tasks 2.1 / 2.2).
 *
 * The claim being tested is that adding an application is adding an entry — so the
 * things that would make that false are what is asserted: a third entry that reads
 * another deployment's settings, two deployments sharing a bucket, or a deployment
 * whose resources are named after a tier rather than after itself.
 */
describe('deployment manifest', () => {
  it('carries more than the staging/production pair', () => {
    // Guards the refactor itself. With only two entries the manifest is
    // indistinguishable from what it replaced, and nothing here would be exercised.
    expect(DEPLOYMENTS.length).toBeGreaterThan(2);
  });

  /**
   * Runs `fn` with a distinct hostname configured for every entry.
   *
   * This is the configuration a multi-deployment account actually has, and it is
   * *not* the suite's default — the rest of these tests deploy one deployment at a
   * time from the bare variables, which is the single-deployment shape.
   */
  function withPerDeploymentHosts<T>(fn: () => T): T {
    const saved = DEPLOYMENTS.map((d) => {
      const key = `${d.name.toUpperCase()}_CDN_HOST`;
      const before = process.env[key];
      process.env[key] = `images.${d.name}.example.com`;
      return [key, before] as const;
    });

    try {
      return fn();
    } finally {
      for (const [key, before] of saved) {
        if (before === undefined) delete process.env[key];
        else process.env[key] = before;
      }
    }
  }

  it('gives every deployment its own bucket and hostname', () => {
    const configs = withPerDeploymentHosts(resolveAllDeployments);

    expect(configs.length).toBe(DEPLOYMENTS.length);
    expect(new Set(configs.map(bucketNameFor)).size).toBe(configs.length);
    expect(new Set(configs.map((c) => c.cdnHost)).size).toBe(configs.length);
  });

  it('prefers the deployment’s own prefix over the bare variable', () => {
    expect(resolveEnvironment('demo').cdnHost).toBe(process.env['DEMO_CDN_HOST']);
    // No STAGING_CDN_HOST is set here, so staging falls back — which is what keeps a
    // single-deployment account working from the plain names it always used.
    expect(resolveEnvironment('staging').cdnHost).toBe(process.env['CDN_HOST']);
  });

  it('refuses two deployments claiming one hostname', () => {
    // The default suite environment is exactly the broken multi-deployment case:
    // staging and production both fall back to the shared CDN_HOST. CloudFront
    // reports that as CNAMEAlreadyExists partway through the *second* deployment,
    // after the first is already created. Named here instead, at synth, with both
    // entries in the message.
    expect(() => resolveAllDeployments()).toThrow(/both claim the CDN hostname/);
    expect(() => resolveAllDeployments()).toThrow(/staging.*production|production.*staging/);
  });

  it('names resources after the deployment, not its tier', () => {
    // `demo` and `staging` share a tier. If anything were keyed off the tier they
    // would collide in the same account — the failure this whole split exists to
    // prevent.
    const demo = resolveEnvironment('demo');
    const staging = resolveEnvironment('staging');

    // Same tier, so the same sizing profile — and still different resource names.
    expect(demo.lambda.optimizerMaxConcurrency).toEqual(staging.lambda.optimizerMaxConcurrency);
    expect(demo.delivery.priceClass).toEqual(staging.delivery.priceClass);
    expect(bucketNameFor(demo)).not.toBe(bucketNameFor(staging));
    expect(bucketNameFor(demo)).toContain('demo');
  });

  it('rejects an unknown deployment by name, listing the real ones', () => {
    expect(() => resolveEnvironment('nope')).toThrow(/Unknown deployment "nope"/);
    expect(() => resolveEnvironment('nope')).toThrow(/demo/);
  });
});

describe('delivery plane', () => {
  it('fails over to the generator on 403 as well as 404', () => {
    // With OAC and no s3:ListBucket, S3 answers a missing key with 403. Configure
    // only 404 and every ungenerated variant shows the viewer access-denied.
    app.cdn.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        OriginGroups: {
          Items: [
            Match.objectLike({
              FailoverCriteria: { StatusCodes: Match.objectLike({ Items: [403, 404] }) },
            }),
          ],
        },
      },
    });
  });

  it('caches on the path alone', () => {
    // Query strings back in the cache key would restore the unbounded variant space
    // that bucketing exists to close, and nothing would look broken.
    app.cdn.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        ParametersInCacheKeyAndForwardedToOrigin: {
          QueryStringsConfig: { QueryStringBehavior: 'none' },
          HeadersConfig: { HeaderBehavior: 'none' },
          CookiesConfig: { CookieBehavior: 'none' },
        },
      },
    });
  });

  /*
   * DNS is Cloudflare's, and certificates are pre-issued.
   *
   * Asserted as an absence because the failure is a slow one: a `Route53::RecordSet`
   * here would need a hosted zone that does not exist, and an `ACM::Certificate` with
   * DNS validation would make CloudFormation sit and wait for a record only a human
   * with a Cloudflare token can create — a deploy that hangs rather than fails. See
   * design.md D18.
   */
  it('creates no DNS records and issues no certificates', () => {
    for (const [name, template] of [
      ['cdn', app.cdn],
      ['compute', app.compute],
    ] as const) {
      expect(Object.keys(template.findResources('AWS::Route53::RecordSet')), name).toHaveLength(0);
      expect(Object.keys(template.findResources('AWS::Route53::HostedZone')), name).toHaveLength(0);
      expect(
        Object.keys(template.findResources('AWS::CertificateManager::Certificate')),
        name,
      ).toHaveLength(0);
    }
  });

  /*
   * A deployment outside us-east-1 still gets a CloudFront certificate.
   *
   * The certificate used to come from a us-east-1 stack, which is why the CDN stack
   * carried `crossRegionReferences: true` — CDK provisions SSM-backed custom resources
   * to move an export across regions. Now the ARN is a literal from configuration, so
   * there is no export to move and that machinery is gone. Asserted rather than
   * assumed: if it were still needed, every non-us-east-1 deployment would break, and
   * the default region hides it.
   *
   * Built by hand rather than through `synthesize()` because the observability stack
   * cannot synthesize outside us-east-1 at all: CloudFront publishes its metrics only
   * there, and CloudWatch refuses an alarm on a metric from another region. That is a
   * real constraint on where the observability stack may be deployed, recorded here
   * because this is the test that would otherwise trip over it.
   */
  it('attaches a us-east-1 certificate from a stack in another region', () => {
    Object.assign(process.env, {
      CDK_ACCOUNT: '123456789012',
      CDK_REGION: 'eu-west-1',
      CDN_HOST: 'images.example.com',
      API_HOST: 'api.example.com',
      API_IMAGE_TAG: 'v-test',
      CDN_CERTIFICATE_ARN: 'arn:aws:acm:us-east-1:123456789012:certificate/aaaa-bbbb',
      WORKER_CALLBACK_URL: 'https://api.example.com',
      WORKER_CALLBACK_SECRET: 'test-worker-secret',
    });

    const config = resolveEnvironment('production');
    const scoped = new App();
    const env = { account: config.account, region: config.region };

    const storage = new StorageStack(scoped, 'S', { env, config });
    const queue = new QueueStack(scoped, 'Q', { env, config });
    const compute = new ComputeStack(scoped, 'C', {
      env,
      config,
      bucket: storage.bucket,
      optimizeQueue: queue.optimizeQueue,
    });
    const cdn = Template.fromStack(
      new CdnStack(scoped, 'CDN', {
        env,
        config,
        generatorFunctionUrl: compute.generatorFunctionUrl,
      }),
    );

    expect(JSON.stringify(cdn.toJSON())).toContain(
      'arn:aws:acm:us-east-1:123456789012:certificate/aaaa-bbbb',
    );
    // What `crossRegionReferences` would have provisioned, and no longer needs to.
    expect(Object.keys(cdn.findResources('Custom::CrossRegionExportReader'))).toHaveLength(0);

    process.env['CDK_REGION'] = 'us-east-1';
  });

  it('publishes the DNS target an external provider needs', () => {
    // The reconciler in infra/cloudflare reads this; a renamed output silently leaves
    // the zone pointing at the previous deployment.
    //
    // One output, not two. The control plane's target used to be a load balancer's DNS
    // name published by the compute stack; it is now a Lightsail static IP, which
    // CloudFormation does not know about and which reaches the reconciler through
    // `API_STATIC_IP` instead.
    expect(Object.keys(app.cdn.findOutputs('CdnDnsTarget'))).toHaveLength(1);
    expect(Object.keys(app.compute.findOutputs('ApiDnsTarget'))).toHaveLength(0);
  });

  it('subscribes to the metrics its own alarms watch', () => {
    // `CacheHitRate` is not published unless a distribution subscribes. Without this
    // the cache-hit alarm sits in INSUFFICIENT_DATA and, treated as not-breaching,
    // reads as healthy forever — on one of only two detectors for normalization
    // drift, which has no other symptom.
    app.cdn.hasResourceProperties('AWS::CloudFront::MonitoringSubscription', {
      MonitoringSubscription: {
        RealtimeMetricsSubscriptionConfig: { RealtimeMetricsSubscriptionStatus: 'Enabled' },
      },
    });
  });

  it('announces the negotiation on both origins, not just the generator', () => {
    // The edge bakes a format chosen from Accept into the path, so these responses
    // are negotiated. S3 cannot store `Vary`, so without this the stored copy of a
    // key and the generated copy of the same key differ in exactly the header that
    // stops an intermediary handing AVIF to a client that cannot decode it.
    app.cdn.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: {
        CustomHeadersConfig: {
          Items: Match.arrayWith([
            Match.objectLike({ Header: 'Vary', Value: 'Accept', Override: true }),
          ]),
        },
      },
    });
  });

  it('collapses requests on the expensive origin too', () => {
    // Origin Shield on S3 only left the generator — the origin that costs a Sharp
    // render per request — without request collapsing.
    const origins = propertyOf<{ Origins: Array<{ OriginShield?: { Enabled?: boolean } }> }>(
      resourcesOf(app.cdn, 'AWS::CloudFront::Distribution')[0],
      'DistributionConfig',
    ).Origins;

    expect(origins.length).toBeGreaterThanOrEqual(2);
    for (const origin of origins) {
      expect(origin.OriginShield?.Enabled).toBe(true);
    }
  });

  it('attaches the generated normalizer on viewer-request', () => {
    app.cdn.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: {
          FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
        },
      },
    });
  });

  it('ships the committed edge function, not a placeholder', () => {
    const code = propertyOf<string>(
      resourcesOf(app.cdn, 'AWS::CloudFront::Function')[0],
      'FunctionCode',
    );

    expect(code).toContain('GENERATED FILE');
    expect(code).toContain('var LADDER');
  });

  it('redirects plain HTTP to HTTPS', () => {
    app.cdn.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: { ViewerProtocolPolicy: 'redirect-to-https' },
      },
    });
  });

  it('never caches a generation failure', () => {
    const distribution = resourcesOf(app.cdn, 'AWS::CloudFront::Distribution')[0];
    const { CustomErrorResponses: responses } = propertyOf<{
      CustomErrorResponses: Array<{ ErrorCode: number; ErrorCachingMinTTL: number }>;
    }>(distribution, 'DistributionConfig');

    const server = responses.filter((r) => r.ErrorCode >= 500);
    expect(server.length).toBeGreaterThan(0);
    // One bad moment must not pin a broken image behind a long TTL.
    expect(server.every((r) => r.ErrorCachingMinTTL === 0)).toBe(true);

    const client = responses.find((r) => r.ErrorCode === 404);
    expect(client?.ErrorCachingMinTTL).toBe(60);
  });
});

describe('storage posture', () => {
  it('blocks public access and encrypts by default', () => {
    app.storage.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.anyValue(),
      }),
    });
  });

  it('retains the bucket', () => {
    // The one failure in this file that cannot be undone.
    //
    // The database used to be asserted alongside it. It is a Lightsail managed
    // database now, provisioned outside CloudFormation, so its deletion protection is
    // a console setting rather than a template property — checked in the bootstrap
    // guide's verification list instead of here.
    app.storage.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  });

  it('expires staging and tiers originals, but leaves derivatives alone', () => {
    const { Rules: rules } = propertyOf<{
      Rules: Array<{ Id: string; Prefix?: string; Transitions?: unknown[] }>;
    }>(assetBucket(), 'LifecycleConfiguration');

    expect(rules.find((r) => r.Id === 'expire-staging')?.Prefix).toBe('staging/');
    expect(rules.find((r) => r.Id === 'tier-originals')?.Transitions).toHaveLength(2);
    // A retrieval-priced class here would add cost to every cache miss.
    expect(rules.some((r) => r.Prefix === 'derived/')).toBe(false);
  });

  /*
   * Versioning is the only thing standing between a reclamation defect and the
   * permanent loss of an original — the one object in this system with no upstream
   * copy, and one that two separate roles are permitted to delete.
   */
  it('versions the bucket and bounds what versioning costs', () => {
    expect(propertyOf<{ Status: string }>(assetBucket(), 'VersioningConfiguration')?.Status).toBe(
      'Enabled',
    );

    const { Rules: rules } = propertyOf<{
      Rules: Array<{
        Id: string;
        Prefix?: string;
        NoncurrentVersionExpiration?: { NoncurrentDays: number };
        ExpiredObjectDeleteMarker?: boolean;
      }>;
    }>(assetBucket(), 'LifecycleConfiguration');

    const sweep = rules.find((r) => r.Id === 'expire-noncurrent-versions');
    expect(sweep?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(
      app.config.storage.noncurrentVersionExpiryDays,
    );
    expect(sweep?.ExpiredObjectDeleteMarker).toBe(true);

    /*
     * The half that is a security control rather than a cost control.
     *
     * Under versioning, `Expiration` on `staging/` writes a delete marker and keeps
     * the bytes — so without its own noncurrent rule, the prefix that holds
     * unvalidated uploads, and whatever the malware quarantine handler deletes,
     * silently becomes a retention policy for exactly those bytes.
     */
    const staging = rules.find((r) => r.Id === 'expire-staging');
    expect(staging?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(
      app.config.storage.stagingNoncurrentExpiryDays,
    );
    expect(staging!.NoncurrentVersionExpiration!.NoncurrentDays).toBeLessThan(
      app.config.storage.noncurrentVersionExpiryDays,
    );
  });

  it('does not deny the encryption-header-less writes this service actually makes', () => {
    // The obvious "deny unencrypted writes" policy denies every write we make, and
    // looks correct in review. This pins the narrower form.
    const document = JSON.stringify(propertyOf<unknown>(assetBucketPolicy(), 'PolicyDocument'));

    expect(document).toContain('DenyExplicitlyUnencryptedWrites');
    expect(document).toContain('"Null":{"s3:x-amz-server-side-encryption":"false"}');
  });
});

/*
 * Rate limiting is no longer here.
 *
 * It was a WAF rule on the load balancer, and a WAF cannot attach to a Lightsail
 * instance — the `REGIONAL` scope covers ALB, API Gateway, and AppSync only. It is now
 * middleware in the control plane at the same limits, tested where it lives:
 * `apps/api/src/common/rate-limit.middleware.test.ts`. See design.md L4 for what that
 * costs, which is not nothing.
 *
 * The absence of any web ACL is asserted in the "no Lambda is VPC-attached" suite,
 * alongside the other resources this change removed.
 */

describe('malware scanning', () => {
  it('scans only the untrusted prefix', () => {
    // Originals are already validated and derivatives are our own encoder output;
    // scanning either is paying per gigabyte to scan ourselves.
    app.storage.hasResourceProperties('AWS::GuardDuty::MalwareProtectionPlan', {
      ProtectedResource: {
        S3Bucket: Match.objectLike({ ObjectPrefixes: ['staging/'] }),
      },
      Actions: { Tagging: { Status: 'ENABLED' } },
    });
  });

  it('tells the workers that a scanner exists', () => {
    /*
     * The app fails closed on a missing verdict, so the flag and the provisioning must
     * agree or every upload is held forever.
     *
     * The control plane used to be asserted here through its task definition. It reads
     * this flag from the instance's `.env` now, which CloudFormation does not own — so
     * the CDK can only prove what it still sets, and the bootstrap guide carries the
     * check that the two agree. That is a genuine weakening of a guard against a
     * failure that presents as a broken uploader, and it is why the guide states the
     * value to copy rather than describing it.
     */
    const fns = resourcesOf(app.compute, 'AWS::Lambda::Function');
    expect(fns.length).toBeGreaterThan(0);

    for (const fn of fns) {
      const env = propertyOf<{ Variables: Record<string, string> }>(fn, 'Environment');
      expect(env.Variables['UPLOAD_MALWARE_SCAN_ENABLED']).toBe('true');
    }
  });

  it('lets the quarantine handler delete only staged objects', () => {
    // One that could reach originals would be an efficient way to lose every source.
    const policies = JSON.stringify(
      entriesOf(app.storage, 'AWS::IAM::Policy')
        .filter(([id]) => id.includes('MalwareQuarantine'))
        .map(([, policy]) => propertyOf<unknown>(policy, 'PolicyDocument')),
    );

    expect(policies).toContain('s3:DeleteObject');
    expect(policies).toContain('staging/*');
    expect(policies).not.toContain('original/*');
  });
});

describe('private delivery', () => {
  it('requires a signature only on its own behavior', () => {
    // Trusted key groups apply per behavior, so putting them on the default one
    // would demand a signature for every public image in the deployment.
    const distribution = resourcesOf(app.cdn, 'AWS::CloudFront::Distribution')[0];
    const configJson = propertyOf<{
      DefaultCacheBehavior: Record<string, unknown>;
      CacheBehaviors: Array<{ PathPattern: string; TrustedKeyGroups?: unknown }>;
    }>(distribution, 'DistributionConfig');

    expect(configJson.DefaultCacheBehavior).not.toHaveProperty('TrustedKeyGroups');

    const private_ = configJson.CacheBehaviors.find((b) => b.PathPattern === '/p/*');
    expect(private_?.TrustedKeyGroups).toBeDefined();
  });

  it('normalizes private assets identically, so the variant space stays bounded', () => {
    const distribution = resourcesOf(app.cdn, 'AWS::CloudFront::Distribution')[0];
    const configJson = propertyOf<{
      CacheBehaviors: Array<{ PathPattern: string; FunctionAssociations?: unknown[] }>;
    }>(distribution, 'DistributionConfig');

    const private_ = configJson.CacheBehaviors.find((b) => b.PathPattern === '/p/*');
    expect(private_?.FunctionAssociations).toHaveLength(1);
  });

  it('holds only the public half of the key pair', () => {
    const key = resourcesOf(app.cdn, 'AWS::CloudFront::PublicKey')[0];
    const encoded = JSON.stringify(propertyOf<unknown>(key, 'PublicKeyConfig'));

    expect(encoded).toContain('BEGIN PUBLIC KEY');
    expect(encoded).not.toContain('PRIVATE KEY');
  });
});

describe('least privilege', () => {
  function statementsFor(role: string): string {
    const matching = entriesOf(app.compute, 'AWS::IAM::Policy').filter(([id]) => id.includes(role));
    return JSON.stringify(
      matching.map(([, policy]) => propertyOf<unknown>(policy, 'PolicyDocument')),
    );
  }

  it('scopes the generator to reading sources and writing derivatives', () => {
    const document = statementsFor('Generator');

    expect(document).toContain('original/*');
    expect(document).toContain('derived/*');
    // It renders; it does not ingest, and it does not delete.
    expect(document).not.toContain('staging/*');
    expect(document).not.toContain('s3:DeleteObject');
  });

  it('never grants an unscoped ListBucket', () => {
    // ListBucket is bucket-level and cannot be scoped by ARN, so the s3:prefix
    // condition is the only thing between "list what you need" and "enumerate every
    // original in the deployment".
    for (const [id, policy] of entriesOf(app.compute, 'AWS::IAM::Policy')) {
      const document = propertyOf<{
        Statement: Array<{ Action?: unknown; Condition?: unknown }>;
      }>(policy, 'PolicyDocument');

      for (const statement of document.Statement) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        if (actions.includes('s3:ListBucket')) {
          expect(statement.Condition, `${id} lists without a prefix condition`).toBeDefined();
          expect(JSON.stringify(statement.Condition)).toContain('s3:prefix');
        }
      }
    }
  });

  it('authenticates the generator Function URL', () => {
    // A public Function URL is an unmetered image-processing endpoint open to the
    // internet, sitting outside every cache and quota in the design.
    app.compute.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  });
});

describe('compute', () => {
  it('gives the sharp layer to exactly the functions that decode images', () => {
    // Maintenance moves and deletes objects and never decodes one, so shipping it a
    // native binary would be dead weight and an extra encoder-epoch coupling.
    const withLayer = resourcesOf(app.compute, 'AWS::Lambda::Function')
      .filter((fn) => propertyOf<unknown[]>(fn, 'Layers') !== undefined)
      .map((fn) => String(propertyOf<string>(fn, 'FunctionName')));

    expect(withLayer.some((n) => n.includes('optimizer'))).toBe(true);
    expect(withLayer.some((n) => n.includes('generator'))).toBe(true);
    expect(withLayer.some((n) => n.includes('maintenance'))).toBe(false);
  });

  it('bounds generator concurrency', () => {
    app.compute.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('generator'),
      ReservedConcurrentExecutions: app.config.lambda.generatorReservedConcurrency,
    });
  });

  it('bounds optimizer fan-out against the shared database', () => {
    // Unbounded, a backlog cures itself by opening hundreds of connections to the
    // small Postgres instance the control plane shares — taking down the API that
    // accepts the uploads that created the backlog.
    app.compute.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      ScalingConfig: { MaximumConcurrency: app.config.lambda.optimizerMaxConcurrency },
    });
  });

  /*
   * TLS at the load balancer, which is where API keys and upload payloads arrive.
   *
   * The listener always knew how to terminate TLS; nothing ever handed it a
   * certificate, so every environment served the control plane in clear.
   */
  it('lets maintenance queue work but never consume it', () => {
    // The re-enqueue job recovers optimizations lost to a failed enqueue. It is not a
    // consumer, and must never be able to receive or delete another consumer's message.
    const policies = resourcesOf(app.compute, 'AWS::IAM::Policy').map((policy) =>
      JSON.stringify(propertyOf<unknown>(policy, 'PolicyDocument')),
    );
    const queuePolicies = policies.filter((document) => document.includes('sqs:SendMessage'));

    expect(queuePolicies.length).toBeGreaterThan(0);
    for (const document of queuePolicies) {
      expect(document).not.toContain('sqs:ReceiveMessage');
      expect(document).not.toContain('sqs:DeleteMessage');
    }
  });
});

describe('alarms', () => {
  it('watches the metric names the code actually emits', () => {
    // An alarm on a misspelled name sits in INSUFFICIENT_DATA forever, which reads
    // as healthy. Both sides import the same constants; this proves it.
    const alarms = resourcesOf(app.observability, 'AWS::CloudWatch::Alarm');
    const watched = new Set(
      alarms.flatMap((a) => {
        const direct = propertyOf<string | undefined>(a, 'MetricName');
        const composed = propertyOf<Array<{ MetricStat?: { Metric?: { MetricName?: string } } }>>(
          a,
          'Metrics',
        );
        return [
          ...(direct !== undefined ? [direct] : []),
          ...(composed ?? []).map((m) => m.MetricStat?.Metric?.MetricName ?? ''),
        ];
      }),
    );

    expect(watched).toContain(METRICS.onDemandGenerations);
    expect(watched).toContain(METRICS.redundantGenerations);
    expect(watched).toContain(METRICS.generationFailures);
  });

  /*
   * The failures no handler-emitted metric can report.
   *
   * A function that dies at init, gets OOM-killed, times out, or is throttled never
   * reaches the code that emits our own metrics — so before these, all three
   * functions could fail continuously while every custom metric read as healthy.
   */
  it('watches the runtime, not only the handler', () => {
    const byName = (fragment: string) =>
      resourcesOf(app.observability, 'AWS::CloudWatch::Alarm').find((a) =>
        String(propertyOf<string>(a, 'AlarmName')).includes(fragment),
      );

    // Throttling is the one failure that makes on-demand generation look better.
    const throttled = byName('generator-throttled');
    expect(propertyOf<string>(throttled, 'MetricName')).toBe('Throttles');
    expect(propertyOf<string>(throttled, 'Namespace')).toBe('AWS/Lambda');
    expect(propertyOf<number>(throttled, 'Threshold')).toBe(0);

    // No `maintenance-errors`: reclamation is a cron job on the control-plane host and
    // publishes no Lambda metrics. `maintenance-stalled`, below, covers it — and covers
    // more, since "no run completed" also catches a container that never started.
    for (const fragment of ['generator-errors', 'optimizer-errors']) {
      const errors = byName(fragment);
      expect(propertyOf<string>(errors, 'MetricName'), fragment).toBe('Errors');
      expect(propertyOf<string>(errors, 'Namespace'), fragment).toBe('AWS/Lambda');
    }

    expect(propertyOf<string>(byName('cdn-5xx'), 'MetricName')).toBe('5xxErrorRate');
  });

  /*
   * The one alarm that must fire on silence.
   *
   * `MaintenanceRuns` only exists when a run completes, so NOT_BREACHING here would
   * reproduce the cache-hit-rate defect exactly: a detector reading healthy forever
   * precisely because nothing is being emitted.
   */
  it('treats a missing maintenance heartbeat as the failure', () => {
    const heartbeat = resourcesOf(app.observability, 'AWS::CloudWatch::Alarm').find((a) =>
      String(propertyOf<string>(a, 'AlarmName')).includes('maintenance-stalled'),
    );

    expect(propertyOf<string>(heartbeat, 'MetricName')).toBe(METRICS.maintenanceRuns);
    expect(propertyOf<string>(heartbeat, 'TreatMissingData')).toBe('breaching');
    expect(propertyOf<string>(heartbeat, 'ComparisonOperator')).toBe('LessThanThreshold');

    // CloudWatch rejects an alarm whose period x evaluationPeriods exceeds one day,
    // and does so at CREATE — after a green synth and a green deploy of everything
    // that came before it.
    const period = propertyOf<number>(heartbeat, 'Period');
    const periods = propertyOf<number>(heartbeat, 'EvaluationPeriods');
    expect(period * periods).toBeLessThanOrEqual(86_400);
  });

  it('alarms on any dead letter at all, not on a tolerance', () => {
    // Expected steady-state depth is zero: a message here failed five times.
    app.observability.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: Match.stringLikeRegexp('dead-letter-depth'),
      Threshold: 0,
      EvaluationPeriods: 1,
    });
  });

  it('requires a sustained plateau before alarming on on-demand generation', () => {
    // New assets legitimately generate. The alarm is looking for a plateau, so a
    // single spiky period must not trip it.
    const alarm = resourcesOf(app.observability, 'AWS::CloudWatch::Alarm').find((a) =>
      String(propertyOf<string>(a, 'AlarmName')).includes('ondemand'),
    );

    expect(propertyOf<number>(alarm, 'EvaluationPeriods')).toBeGreaterThan(1);
    expect(propertyOf<number>(alarm, 'DatapointsToAlarm')).toBeGreaterThan(1);
  });

  it('alarms on generation failure rate rather than raw count', () => {
    // A count alarms on a traffic spike and stays quiet at 3am when most requests
    // fail. The ratio is what describes the service.
    const alarm = resourcesOf(app.observability, 'AWS::CloudWatch::Alarm').find((a) =>
      String(propertyOf<string>(a, 'AlarmName')).includes('failure-rate'),
    );

    expect(JSON.stringify(propertyOf<unknown>(alarm, 'Metrics'))).toContain('Expression');
  });

  it('routes every alarm to the notification topic', () => {
    // An alarm with no action is a dashboard decoration.
    for (const a of resourcesOf(app.observability, 'AWS::CloudWatch::Alarm')) {
      expect(propertyOf<unknown[]>(a, 'AlarmActions')).toHaveLength(1);
    }
  });

  it('covers every condition the spec names', () => {
    const names = resourcesOf(app.observability, 'AWS::CloudWatch::Alarm').map((a) =>
      String(propertyOf<string>(a, 'AlarmName')),
    );

    for (const condition of [
      'dead-letter-depth',
      'queue-age',
      'generation-failure-rate',
      'cache-hit-rate',
      'api-5xx',
      // Was `unhealthy-tasks`, from the load balancer's target health. The control
      // plane is one instance now, so the closest available signal is its status
      // check — which is weaker, and design.md L4 says so rather than pretending
      // otherwise.
      'control-plane-status',
      'maintenance-stalled',
    ]) {
      expect(
        names.some((n) => n.includes(condition)),
        `no alarm for ${condition}`,
      ).toBe(true);
    }
  });
});

describe('dashboard', () => {
  it('exists and leads with the failure that looks healthy', () => {
    const dashboard = resourcesOf(app.observability, 'AWS::CloudWatch::Dashboard')[0];
    // The body is an Fn::Join of literals and resource references, not a plain
    // string, so it is stringified rather than coerced.
    const body = JSON.stringify(propertyOf<unknown>(dashboard, 'DashboardBody'));

    expect(body).toContain(METRICS.onDemandGenerations);
    expect(body).toContain('CacheHitRate');
    expect(body).toContain(METRICS.bytesServed);
  });
});

describe('tracing is confined to the control path', () => {
  it('traces the optimizer', () => {
    app.compute.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('optimizer'),
      TracingConfig: { Mode: 'Active' },
    });
  });

  it('does not trace the generator', () => {
    // Per-request tracing at CDN volume would cost more than the traffic it
    // observes, and the useful question here is a metric, not a trace.
    const generator = resourcesOf(app.compute, 'AWS::Lambda::Function').find((fn) =>
      String(propertyOf<string>(fn, 'FunctionName') ?? '').includes('generator'),
    );

    expect(propertyOf<unknown>(generator, 'TracingConfig')).toBeUndefined();
  });
});

describe('lifecycle and cost controls', () => {
  it('makes the CloudFront price class a per-environment decision', () => {
    // Delivery is ~75% of the bill, and edge coverage is the lever with the most
    // direct effect on it.
    const distribution = resourcesOf(app.cdn, 'AWS::CloudFront::Distribution')[0];
    const priceClass = propertyOf<{ PriceClass: string }>(
      distribution,
      'DistributionConfig',
    ).PriceClass;

    expect(priceClass).toBe('PriceClass_All');
    expect(resolveEnvironment('staging').delivery.priceClass).not.toBe(
      resolveEnvironment('production').delivery.priceClass,
    );
  });
});

describe('queue', () => {
  it('dead-letters after the configured attempts', () => {
    app.queue.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: Match.stringLikeRegexp('optimize$'),
      RedrivePolicy: Match.objectLike({ maxReceiveCount: app.config.queue.maxReceiveCount }),
    });
  });

  it('keeps dead letters long enough to investigate', () => {
    app.queue.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: Match.stringLikeRegexp('dlq$'),
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
    });
  });
});

/*
 * The saving, asserted rather than assumed (task 4.9).
 *
 * This suite replaces the one that checked the VPC's subnets and endpoints. The whole
 * cost reduction rests on a single property — that no Lambda is attached to a VPC —
 * because a VPC-attached function is what a NAT gateway and six interface endpoints
 * exist to serve. Putting one back reintroduces $76.65/month, and it would do so
 * silently: the deployment would work perfectly, and the bill would arrive a month
 * later.
 */
describe('no Lambda is VPC-attached', () => {
  it('gives no function a VPC config', () => {
    for (const fn of resourcesOf(app.compute, 'AWS::Lambda::Function')) {
      expect(
        propertyOf<unknown>(fn, 'VpcConfig'),
        'a VPC-attached Lambda brings back the NAT gateway and every interface endpoint',
      ).toBeUndefined();
    }
  });

  it('synthesizes no VPC, NAT gateway, or interface endpoint anywhere', () => {
    for (const template of [app.storage, app.queue, app.compute, app.cdn, app.observability]) {
      expect(Object.keys(template.findResources('AWS::EC2::VPC'))).toHaveLength(0);
      expect(Object.keys(template.findResources('AWS::EC2::NatGateway'))).toHaveLength(0);
      expect(Object.keys(template.findResources('AWS::EC2::VPCEndpoint'))).toHaveLength(0);
      expect(Object.keys(template.findResources('AWS::EC2::SecurityGroup'))).toHaveLength(0);
    }
  });

  it('creates no database, load balancer, or ECS resource', () => {
    // Each of these was a line in the old cost floor. Asserted as absent so that
    // "we removed it" stays true rather than becoming folklore.
    for (const template of [app.storage, app.queue, app.compute, app.cdn, app.observability]) {
      for (const type of [
        'AWS::RDS::DBInstance',
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
        'AWS::ECS::Cluster',
        'AWS::ECS::Service',
        'AWS::ECS::TaskDefinition',
        'AWS::WAFv2::WebACL',
        'AWS::ECR::Repository',
      ]) {
        expect(Object.keys(template.findResources(type)), `${type} should be gone`).toHaveLength(0);
      }
    }
  });

  it('gives the workers no database credential', () => {
    // The security property behind design.md L2: the database is reachable only from
    // the control-plane host, so a worker holding a connection string would be both a
    // credential to steal and a reason to put the VPC back.
    for (const fn of resourcesOf(app.compute, 'AWS::Lambda::Function')) {
      const env = JSON.stringify(propertyOf<unknown>(fn, 'Environment') ?? {});
      expect(env).not.toContain('DATABASE_URL');
      expect(env).not.toContain('DB_SECRET_ARN');
      expect(env).not.toContain('DB_PASSWORD');
    }
  });

  it('tells the workers where the control plane is', () => {
    for (const fn of resourcesOf(app.compute, 'AWS::Lambda::Function')) {
      const env = JSON.stringify(propertyOf<unknown>(fn, 'Environment') ?? {});
      expect(env).toContain('WORKER_CALLBACK_URL');
      expect(env).toContain('WORKER_CALLBACK_SECRET');
    }
  });
});
