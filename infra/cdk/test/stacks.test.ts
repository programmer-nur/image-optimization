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
import { ENVIRONMENTS, type EnvironmentConfig } from '../lib/config.js';
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
 * Synthesis only needs the directories to exist and be non-empty; what CDK zips is
 * irrelevant to the template. Creating them here keeps these tests runnable on a
 * fresh clone without a Docker daemon or an esbuild pass.
 */
function stubArtifacts(): void {
  const dirs = [
    join(repoRoot, 'apps', 'optimizer', 'dist-bundle'),
    join(repoRoot, 'apps', 'generator', 'dist-bundle'),
    join(repoRoot, 'apps', 'maintenance', 'dist-bundle'),
    join(here, '..', 'layers', 'sharp'),
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.synth-placeholder'), 'created by infra/cdk tests\n');
  }
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

function synthesize(environment: string): Synthesized {
  Object.assign(process.env, {
    CDK_ACCOUNT: '123456789012',
    CDK_REGION: 'us-east-1',
    CDN_HOST: 'images.example.com',
  });

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
    optimizerFunctionName: 'imgopt-test-optimizer',
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
    const bucket = resourcesOf(app.storage, 'AWS::S3::Bucket')[0];
    const { Rules: rules } = propertyOf<{
      Rules: Array<{ Id: string; Prefix?: string; Transitions?: unknown[] }>;
    }>(bucket, 'LifecycleConfiguration');

    expect(rules.find((r) => r.Id === 'expire-staging')?.Prefix).toBe('staging/');
    expect(rules.find((r) => r.Id === 'tier-originals')?.Transitions).toHaveLength(2);
    // A retrieval-priced class here would add cost to every cache miss.
    expect(rules.some((r) => r.Prefix === 'derived/')).toBe(false);
  });

  it('does not deny the encryption-header-less writes this service actually makes', () => {
    // The obvious "deny unencrypted writes" policy denies every write we make, and
    // looks correct in review. This pins the narrower form.
    const policy = resourcesOf(app.storage, 'AWS::S3::BucketPolicy')[0];
    const document = JSON.stringify(propertyOf<unknown>(policy, 'PolicyDocument'));

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
