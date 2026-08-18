/**
 * CDN stack — the delivery plane.
 *
 * The whole architecture lands here:
 *
 *   viewer request
 *     -> CloudFront Function rewrites the URI to the canonical key, drops the query
 *     -> cache lookup on that path alone
 *     -> S3 serves the derivative if the object exists
 *     -> if it does not, S3 answers 403 and CloudFront fails over to the generator,
 *        which renders it, writes it to that exact key, and returns the bytes
 *
 * Every later request for that variant, globally and forever, is a cache or S3 hit.
 * See design.md D5.
 */

import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { bucketNameFor, type EnvironmentConfig } from './config.js';
import { edgeFunctionPath } from './artifacts.js';
import { createPrivateDelivery } from './private-delivery.js';

export interface CdnStackProps extends StackProps {
  config: EnvironmentConfig;
  generatorFunctionUrl: lambda.IFunctionUrl;
  /** Issued in the us-east-1 certificate stack when the hosted zone is ours. */
  issuedCertificate?: acm.ICertificate;
}

export class CdnStack extends Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CdnStackProps) {
    super(scope, id, props);

    const { config, generatorFunctionUrl } = props;

    /*
     * Imported by name, not taken as a construct.
     *
     * Handing CDK the real bucket makes it attach the origin access control policy
     * to that bucket, in the storage stack, referencing this distribution — storage
     * then depends on CDN, CDN on compute, compute on storage. Importing leaves the
     * policy to the storage stack, where it is written explicitly, and keeps the
     * dependency arrows pointing one way. CDK logs that it cannot update an imported
     * bucket's policy; that is the intended outcome here, not a warning to fix.
     */
    const bucket = s3.Bucket.fromBucketName(this, 'DerivativeBucket', bucketNameFor(config));

    // Imported by name for the same reason the asset bucket is: taking the construct
    // would make storage depend on CDN and close a cycle through compute.
    const logBucket = s3.Bucket.fromBucketName(this, 'LogBucket', `${bucketNameFor(config)}-logs`);

    /*
     * The edge normalizer, read from the generated file.
     *
     * Generated from `packages/core` and never hand-edited: if the edge and the core
     * library ever disagree on normalization, CloudFront computes cache key A while
     * the generator writes object B. The result is a permanent 100% miss on that
     * variant — every request invoking Lambda, forever, with nothing appearing in
     * any error metric. The conformance suite in infra/cloudfront is what keeps them
     * honest. See design.md D4.
     */
    const normalizer = new cloudfront.Function(this, 'Normalizer', {
      functionName: `imgopt-${config.name}-normalize`,
      code: cloudfront.FunctionCode.fromFile({ filePath: edgeFunctionPath() }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Generated from @imgopt/core. Do not edit in the console.',
    });

    /*
     * Cache key: the path, and nothing else.
     *
     * No query strings — the normalizer resolved them into the path already, and
     * including them would restore the unbounded key space bucketing exists to
     * close. No headers, and specifically not `Accept`: the format is baked into the
     * path, so varying on the raw header would fragment the cache by the wildly
     * varied strings browsers actually send. No cookies, ever, on images.
     */
    const cachePolicy = new cloudfront.CachePolicy(this, 'DerivativeCachePolicy', {
      cachePolicyName: `imgopt-${config.name}-derivatives`,
      comment: 'Path-only cache key; the edge function resolved everything else',
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      defaultTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket, {
      // Collapses concurrent misses for the same key into a single origin fetch,
      // which is most of the answer to a thundering herd on newly published HTML.
      originShieldEnabled: true,
      originShieldRegion: this.region,
    });

    /*
     * OAC signs CloudFront's requests to the Function URL, which is `AWS_IAM`-authed
     * and therefore not reachable directly from the internet.
     *
     * Origin Shield on the fallback too, and it matters more here than on S3: this is
     * the expensive origin. A newly published page can put thousands of viewers onto
     * one uncached variant at once, and without request collapsing each edge location
     * invokes the generator separately. The writes stay correct — generation is
     * deterministic and the write is conditional — but every duplicate is a Sharp
     * render nobody needed.
     */
    const generatorOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(
      generatorFunctionUrl,
      {
        originShieldEnabled: true,
        originShieldRegion: this.region,
      },
    );

    const origin = new origins.OriginGroup({
      primaryOrigin: s3Origin,
      fallbackOrigin: generatorOrigin,
      /*
       * 403 first, and it is not a typo.
       *
       * With OAC and no `s3:ListBucket` permission — which is deliberate, since the
       * distribution has no business enumerating the bucket — S3 answers a missing
       * key with 403, not 404. Configure only 404 here and every ungenerated variant
       * shows the viewer an access-denied error instead of an image. 404 is included
       * for the case where list permission exists anyway.
       */
      fallbackStatusCodes: [403, 404],
    });

    const privateDelivery =
      config.privateDeliveryPublicKey === undefined
        ? undefined
        : createPrivateDelivery(this, {
            environment: config.name,
            publicKeyPem: config.privateDeliveryPublicKey,
          });

    const headersPolicy = this.responseHeaders(config);
    const certificate = this.resolveCertificate(config, props.issuedCertificate);
    const domainNames = certificate === undefined ? undefined : [config.cdnHost];

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `imgopt ${config.name}`,
      priceClass: config.delivery.priceClass,
      /*
       * Standard access logs. The delivery plane is unauthenticated, so these are the
       * only record of who asked for what — and the only way to tell a scraper from a
       * consuming application after the fact. Expired by the log bucket's own rule.
       */
      enableLogging: true,
      logBucket,
      logFilePrefix: 'cloudfront/',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      ...(certificate !== undefined ? { certificate } : {}),
      ...(domainNames !== undefined ? { domainNames } : {}),
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy,
        originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
        responseHeadersPolicy: headersPolicy,
        compress: true,
        functionAssociations: [
          { function: normalizer, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      // Signature-required delivery, when configured. A separate behavior rather
      // than a flag on the default one: trusted key groups apply to a whole
      // behavior, so enabling it above would demand a signature for every public
      // image in the deployment.
      ...(privateDelivery !== undefined
        ? {
            additionalBehaviors: {
              [privateDelivery.pathPattern]: {
                origin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
                cachePolicy,
                responseHeadersPolicy: headersPolicy,
                compress: true,
                // Same normalizer: a private asset is bucketed exactly like a public
                // one, so the variant space stays bounded either way.
                functionAssociations: [
                  { function: normalizer, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
                ],
                trustedKeyGroups: [privateDelivery.keyGroup],
              },
            },
          }
        : {}),
      errorResponses: [
        // Short, so a corrected URL or a later upload recovers quickly instead of
        // being pinned behind a long negative cache. See design.md D8.
        { httpStatus: 400, ttl: Duration.seconds(60) },
        { httpStatus: 404, ttl: Duration.seconds(60) },
        // Generation failures are never persisted. One bad moment must not pin a
        // broken image at the edge.
        { httpStatus: 500, ttl: Duration.seconds(0) },
        { httpStatus: 502, ttl: Duration.seconds(0) },
        { httpStatus: 503, ttl: Duration.seconds(0) },
        { httpStatus: 504, ttl: Duration.seconds(0) },
      ],
    });

    this.createDnsRecord(config);

    /*
     * Additional CloudFront metrics.
     *
     * `CacheHitRate` is not published at all unless a distribution subscribes to it.
     * Without this the cache-hit alarm sits in INSUFFICIENT_DATA and, treated as
     * not-breaching, reads as healthy forever — the silent-disarm failure this
     * stack's comments warn about, on one of only two detectors for edge/core
     * normalization drift. Drift produces no errors, no 5xx, and no latency change;
     * a hit rate that quietly collapses is most of the evidence there is.
     *
     * All-or-nothing: it enables the whole additional-metric set at standard
     * custom-metric pricing, roughly $2.40 per distribution per month. That is
     * noise against the unbounded Lambda spend it exists to detect.
     */
    new cloudfront.CfnMonitoringSubscription(this, 'AdditionalMetrics', {
      distributionId: this.distribution.distributionId,
      monitoringSubscription: {
        realtimeMetricsSubscriptionConfig: { realtimeMetricsSubscriptionStatus: 'Enabled' },
      },
    });

    if (privateDelivery !== undefined) {
      new CfnOutput(this, 'PrivateDeliveryKeyGroupId', {
        value: privateDelivery.keyGroup.keyGroupId,
        description: 'Signed-URL key group; sign with the matching private key',
      });
      new CfnOutput(this, 'PrivateDeliveryPathPattern', { value: privateDelivery.pathPattern });
    }

    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
    });
    new CfnOutput(this, 'DeliveryUrl', {
      value:
        certificate !== undefined
          ? `https://${config.cdnHost}`
          : `https://${this.distribution.distributionDomainName}`,
      description: 'Base delivery URL; set CDN_HOST on the API to match',
    });
  }

  /**
   * Security headers applied uniformly.
   *
   * Set at the distribution rather than on each origin, so a stored object and a
   * freshly generated one carry exactly the same headers. `nosniff` matters more
   * than usual here: every response is attacker-influenced bytes rendered by a
   * browser, and content sniffing is how an "image" becomes something else.
   */
  private responseHeaders(config: EnvironmentConfig): cloudfront.ResponseHeadersPolicy {
    return new cloudfront.ResponseHeadersPolicy(this, 'DeliveryHeaders', {
      responseHeadersPolicyName: `imgopt-${config.name}-delivery`,
      /*
       * `Vary: Accept`, added here because S3 cannot store it.
       *
       * The edge function reads `Accept` and bakes a concrete format into the path,
       * so these responses *are* content-negotiated. A stored object carries
       * Content-Type and Cache-Control and nothing that tells a shared cache the
       * response depended on a request header — so the generated copy of a key
       * announced the negotiation and the S3-served copy of the same key did not.
       * An intermediary cache could then hand an AVIF to a client that cannot decode
       * it, and only for variants that had already been generated once.
       *
       * `override: true` replaces the origin's header rather than appending, so the
       * failover path carries one `Vary`, not two. It is safe to replace because the
       * bucket has no CORS configuration and therefore no other `Vary` to clobber —
       * adding one means revisiting this header and the cache policy together.
       *
       * No cache-key interaction: the cache policy forwards no headers, so `Vary`
       * cannot fragment the CDN cache.
       */
      customHeadersBehavior: {
        customHeaders: [{ header: 'Vary', value: 'Accept', override: true }],
      },
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
      },
    });
  }

  /**
   * The distribution certificate must live in us-east-1 regardless of where the rest
   * of the deployment runs — a CloudFront constraint, not a choice.
   */
  private resolveCertificate(
    config: EnvironmentConfig,
    issued: acm.ICertificate | undefined,
  ): acm.ICertificate | undefined {
    // An explicit ARN wins: it is how an externally managed zone, or a certificate
    // shared across environments, is brought in.
    if (config.cdnCertificateArn !== undefined) {
      return acm.Certificate.fromCertificateArn(this, 'CdnCertificate', config.cdnCertificateArn);
    }
    // Without either, the distribution serves on its own *.cloudfront.net name. The
    // deployment still works end to end, which keeps a first deploy from requiring
    // DNS to be sorted out first.
    return issued;
  }

  /**
   * Creates the alias record when the hosted zone is in this account.
   *
   * When it is not, the deployment still succeeds and the outputs carry the record
   * to create by hand. Failing here instead would make an externally managed zone —
   * a completely normal arrangement — into a blocker.
   */
  private createDnsRecord(config: EnvironmentConfig): void {
    if (config.hostedZoneId === undefined || config.hostedZoneName === undefined) {
      new CfnOutput(this, 'ManualDnsRecord', {
        value: `${config.cdnHost} CNAME ${this.distribution.distributionDomainName}`,
        description:
          'No hosted zone configured. Create this record manually, then re-run the smoke test.',
      });
      return;
    }

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: config.hostedZoneId,
      zoneName: config.hostedZoneName,
    });

    new route53.ARecord(this, 'CdnAliasRecord', {
      zone,
      recordName: config.cdnHost,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
    });

    new route53.AaaaRecord(this, 'CdnAliasRecordV6', {
      zone,
      recordName: config.cdnHost,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
    });
  }
}
