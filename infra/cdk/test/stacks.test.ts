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

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { METRICS } from '@imgopt/metrics';
import { ENVIRONMENTS, bucketNameFor, type EnvironmentConfig } from '../lib/config.js';
import { NetworkStack } from '../lib/network-stack.js';
import { StorageStack } from '../lib/storage-stack.js';
import { DataStack } from '../lib/data-stack.js';
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

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

/**
 * Stands in for the real build artifacts.
 *
 * Synthesis only needs the directories to exist and hold an entrypoint; what CDK zips
 * is irrelevant to the template. Creating them here keeps these tests runnable on a
 * fresh clone without a Docker daemon or an esbuild pass.
 *
 * The stub is deliberately named `index.mjs`, matching what the real bundles emit:
 * `artifacts.ts` asserts that name so an ESM bundle written to a bare `.js` fails at
 * synth instead of at every invocation of the deployed function. A stub that ignored
 * the rule would make these tests pass over exactly the mistake the rule exists for.
 * The packaging job in CI builds the real bundles and is what proves they land there.
 */
function stubArtifacts(): void {
  const bundleDirs = [
    join(repoRoot, 'apps', 'optimizer', 'dist-bundle'),
    join(repoRoot, 'apps', 'generator', 'dist-bundle'),
    join(repoRoot, 'apps', 'maintenance', 'dist-bundle'),
  ];

  for (const dir of bundleDirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.mjs'), '// created by infra/cdk tests\n');
  }

  const layer = join(here, '..', 'layers', 'sharp');
  mkdirSync(layer, { recursive: true });
  writeFileSync(join(layer, '.synth-placeholder'), 'created by infra/cdk tests\n');
}

interface Synthesized {
  config: EnvironmentConfig;
  network: Template;
  storage: Template;
  data: Template;
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
    // An ARN rather than an issued certificate, so these tests need no certificate
    // stack. Production refuses to synthesize without one.
    API_CERTIFICATE_ARN:
      'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555',
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const config = ENVIRONMENTS[environment]!();
  // Exercise the optional security features rather than synthesizing them away.
  config.malwareScanning = true;
  config.privateDeliveryPublicKey = TEST_PUBLIC_KEY;
  const app = new App();
  const env = { account: config.account, region: config.region };

  const network = new NetworkStack(app, 'Network', { env, config });
  const storage = new StorageStack(app, 'Storage', { env, config });
  const queue = new QueueStack(app, 'Queue', { env, config });
  const data = new DataStack(app, 'Data', {
    env,
    config,
    vpc: network.vpc,
    databaseSecurityGroup: network.databaseSecurityGroup,
  });
  const compute = new ComputeStack(app, 'Compute', {
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
    maintenanceFunctionName: compute.maintenance.functionName,
    distributionId: cdn.distribution.distributionId,
    loadBalancerFullName: compute.loadBalancer.loadBalancerFullName,
    targetGroupFullName: compute.targetGroupFullName,
  });

  return {
    config,
    observability: Template.fromStack(observability),
    network: Template.fromStack(network),
    storage: Template.fromStack(storage),
    data: Template.fromStack(data),
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
    for (const template of [
      app.network,
      app.storage,
      app.data,
      app.queue,
      app.compute,
      app.cdn,
      app.observability,
    ]) {
      const json = template.toJSON() as { Resources: Record<string, unknown> };
      expect(Object.keys(json.Resources).length).toBeGreaterThan(0);
    }
  });

  it('synthesizes every configured environment', () => {
    for (const name of Object.keys(ENVIRONMENTS)) {
      expect(() => synthesize(name), `${name} failed to synthesize`).not.toThrow();
    }
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

  it('retains the bucket and the database', () => {
    // The one failure in this file that cannot be undone.
    app.storage.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    app.data.hasResource('AWS::RDS::DBInstance', { DeletionPolicy: 'Retain' });
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

describe('rate limiting sits ahead of the application', () => {
  it('associates a web ACL with the load balancer', () => {
    // A per-instance limiter would give an attacker a budget that scales with the
    // service, and widen exactly when the service is already struggling.
    app.compute.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
      ResourceArn: Match.anyValue(),
      WebACLArn: Match.anyValue(),
    });
  });

  it('rate-limits mutating requests more tightly than reads', () => {
    const acl = resourcesOf(app.compute, 'AWS::WAFv2::WebACL')[0];
    const rules = propertyOf<Array<{ Name: string; Statement: Record<string, unknown> }>>(
      acl,
      'Rules',
    );

    const mutating = rules.find((r) => r.Name === 'RateLimitMutating');
    const overall = rules.find((r) => r.Name === 'RateLimitOverall');
    const limitOf = (rule: typeof mutating) =>
      (rule?.Statement as { RateBasedStatement?: { Limit?: number } } | undefined)
        ?.RateBasedStatement?.Limit;

    expect(limitOf(mutating)).toBeLessThan(limitOf(overall)!);
  });

  it('counts the broad managed ruleset rather than blocking on it', () => {
    // The common ruleset flags ordinary multipart image uploads. Blocking on day one
    // would look like a broken uploader, not a WAF.
    const acl = resourcesOf(app.compute, 'AWS::WAFv2::WebACL')[0];
    const rules = propertyOf<Array<{ Name: string; OverrideAction?: Record<string, unknown> }>>(
      acl,
      'Rules',
    );

    expect(rules.find((r) => r.Name === 'AWSManagedCommon')?.OverrideAction).toHaveProperty(
      'Count',
    );
    expect(rules.find((r) => r.Name === 'AWSManagedKnownBadInputs')?.OverrideAction).toHaveProperty(
      'None',
    );
  });
});

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

  it('tells the control plane that a scanner exists', () => {
    // The app fails closed on a missing verdict, so these two must agree or every
    // upload is held forever.
    const containers = resourcesOf(app.compute, 'AWS::ECS::TaskDefinition').flatMap(
      (task) =>
        propertyOf<Array<{ Environment?: Array<{ Name: string; Value: string }> }>>(
          task,
          'ContainerDefinitions',
        ) ?? [],
    );
    const api = containers.find((c) =>
      (c.Environment ?? []).some((e) => e.Name === 'UPLOAD_MALWARE_SCAN_ENABLED'),
    );

    expect(
      (api?.Environment ?? []).find((e) => e.Name === 'UPLOAD_MALWARE_SCAN_ENABLED')?.Value,
    ).toBe('true');
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
  it('runs every function on arm64', () => {
    const ours = resourcesOf(app.compute, 'AWS::Lambda::Function').filter((fn) =>
      String(propertyOf<string>(fn, 'FunctionName') ?? '').startsWith('imgopt-'),
    );

    expect(ours.length).toBeGreaterThanOrEqual(3);
    for (const fn of ours) {
      expect(propertyOf<string[]>(fn, 'Architectures')).toEqual(['arm64']);
    }
  });

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
  it('terminates TLS and answers port 80 only to redirect', () => {
    app.compute.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      Certificates: Match.anyValue(),
      // CDK's default still negotiates TLS 1.0/1.1.
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
    });

    app.compute.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: Match.arrayWith([
        Match.objectLike({
          Type: 'redirect',
          RedirectConfig: Match.objectLike({
            Protocol: 'HTTPS',
            Port: '443',
            StatusCode: 'HTTP_301',
          }),
        }),
      ]),
    });
  });

  it('refuses to synthesize a production control plane without a certificate', () => {
    // The failure mode this guards is silent: an optional prop nobody passes, and a
    // listener that quietly falls back to plain HTTP.
    expect(() =>
      synthesize('production', { API_CERTIFICATE_ARN: undefined, API_HOST: undefined }),
    ).toThrow(/terminate TLS/);
  });

  it('still lets staging deploy before DNS exists', () => {
    // Deliberate asymmetry: a first staging deploy has to be possible before a
    // hostname is decided, and staging is not where credentials are worth stealing.
    expect(() =>
      synthesize('staging', { API_CERTIFICATE_ARN: undefined, API_HOST: undefined }),
    ).not.toThrow();
  });

  it('runs migrations through the image script, not the CLI directly', () => {
    // The CLI needs DATABASE_URL, which this container deliberately does not carry.
    const containers = resourcesOf(app.compute, 'AWS::ECS::TaskDefinition').flatMap(
      (task) =>
        propertyOf<Array<{ Name: string; Command?: string[] }>>(task, 'ContainerDefinitions') ?? [],
    );
    const migrate = containers.find((container) => container.Name === 'migrate');

    expect(migrate?.Command).toEqual(['node', 'packages/db/scripts/migrate.mjs']);
  });

  it('pins every container image to something other than latest', () => {
    // `latest` makes "redeploy the previous version" ambiguous — it lets the service
    // and the migration task run different bytes under one name, and it lets an
    // unchanged task definition pick up a new sidecar on the next deploy.
    const containers = resourcesOf(app.compute, 'AWS::ECS::TaskDefinition').flatMap(
      (task) => propertyOf<Array<{ Image?: unknown }>>(task, 'ContainerDefinitions') ?? [],
    );

    expect(containers.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(containers)).not.toContain(':latest');
    // And ours really carries the configured tag, rather than merely not saying
    // `latest` because the image reference was built some other way.
    expect(JSON.stringify(containers)).toContain(`:${app.config.api.imageTag}`);
  });

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

  it('takes the database password from the secret store, never from plain env', () => {
    const containers = resourcesOf(app.compute, 'AWS::ECS::TaskDefinition').flatMap(
      (task) =>
        propertyOf<
          Array<{
            Environment?: Array<{ Name: string; Value: unknown }>;
            Secrets?: Array<{ Name: string }>;
          }>
        >(task, 'ContainerDefinitions') ?? [],
    );

    // No container anywhere may carry a credential in plain environment — including
    // sidecars, which have no business holding one.
    for (const container of containers) {
      const names = (container.Environment ?? []).map((e) => e.Name);
      expect(names).not.toContain('DB_PASSWORD');
      expect(names).not.toContain('DATABASE_URL');
    }

    // Containers that actually reach the database take the password from the secret
    // store. The X-Ray sidecar reaches nothing and correctly declares no secrets.
    const withDatabase = containers.filter((c) =>
      (c.Environment ?? []).some((e) => e.Name === 'DB_HOST'),
    );

    expect(withDatabase.length).toBeGreaterThan(0);
    for (const container of withDatabase) {
      expect((container.Secrets ?? []).map((s) => s.Name)).toContain('DB_PASSWORD');
    }
  });

  it('gives the migration task its own definition rather than a container entrypoint', () => {
    // Several tasks starting at once would otherwise race to apply the same
    // migration, and the result is a half-migrated schema, not a clean error.
    const tasks = resourcesOf(app.compute, 'AWS::ECS::TaskDefinition');
    const migration = tasks.filter((task) =>
      JSON.stringify(propertyOf<unknown>(task, 'ContainerDefinitions')).includes('migrate'),
    );

    expect(migration).toHaveLength(1);
    expect(tasks.length).toBeGreaterThan(1);
  });

  it('checks readiness rather than liveness at the load balancer', () => {
    app.compute.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/readyz',
    });
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

    for (const fragment of ['generator-errors', 'optimizer-errors', 'maintenance-errors']) {
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
      'unhealthy-tasks',
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
  it('schedules the maintenance worker', () => {
    app.compute.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: Match.stringLikeRegexp('rate'),
      State: 'ENABLED',
    });
  });

  it('gives maintenance the only role that can delete an original', () => {
    // Granted knowingly: reclaiming a superseded version means deleting its source,
    // and nothing else in the system is permitted to.
    const deleters = entriesOf(app.compute, 'AWS::IAM::Policy').filter(([, policy]) => {
      const document = JSON.stringify(propertyOf<unknown>(policy, 'PolicyDocument'));
      return document.includes('s3:DeleteObject') && document.includes('original/*');
    });

    const names = deleters.map(([id]) => id);
    expect(names.some((n) => n.includes('Maintenance'))).toBe(true);
    expect(names.some((n) => n.includes('Generator'))).toBe(false);
    expect(names.some((n) => n.includes('Optimizer'))).toBe(false);
  });

  it('carries the lifecycle windows into the function environment', () => {
    const maintenance = resourcesOf(app.compute, 'AWS::Lambda::Function').find((fn) =>
      String(propertyOf<string>(fn, 'FunctionName') ?? '').includes('maintenance'),
    );
    const env = propertyOf<{ Variables: Record<string, string> }>(maintenance, 'Environment');

    expect(env.Variables['ORPHAN_SAFETY_WINDOW_HOURS']).toBeDefined();
    expect(env.Variables['SUPERSEDED_RETENTION_DAYS']).toBeDefined();
    expect(env.Variables['MAX_DELETIONS_PER_RUN']).toBeDefined();
  });

  it('ships maintenance without the sharp layer', () => {
    // It moves and deletes objects and never decodes one, so it needs no native
    // binary — and stays outside the encoder-epoch coupling entirely.
    const maintenance = resourcesOf(app.compute, 'AWS::Lambda::Function').find((fn) =>
      String(propertyOf<string>(fn, 'FunctionName') ?? '').includes('maintenance'),
    );

    expect(propertyOf<unknown[]>(maintenance, 'Layers')).toBeUndefined();
  });

  it('makes the CloudFront price class a per-environment decision', () => {
    // Delivery is ~75% of the bill, and edge coverage is the lever with the most
    // direct effect on it.
    const distribution = resourcesOf(app.cdn, 'AWS::CloudFront::Distribution')[0];
    const priceClass = propertyOf<{ PriceClass: string }>(
      distribution,
      'DistributionConfig',
    ).PriceClass;

    expect(priceClass).toBe('PriceClass_All');
    expect(ENVIRONMENTS['staging']!().delivery.priceClass).not.toBe(
      ENVIRONMENTS['production']!().delivery.priceClass,
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

describe('network', () => {
  it('keeps object traffic off the NAT with a gateway endpoint', () => {
    app.network.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
      ServiceName: Match.anyValue(),
    });
  });

  it('puts the database in isolated subnets', () => {
    const isolated = resourcesOf(app.network, 'AWS::EC2::Subnet').filter((subnet) =>
      JSON.stringify(propertyOf<unknown>(subnet, 'Tags')).includes('Isolated'),
    );

    expect(isolated.length).toBeGreaterThan(0);
  });
});
