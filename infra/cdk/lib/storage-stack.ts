/**
 * Storage stack — the one bucket, its access posture, and its lifecycle rules.
 *
 * Stateful and retained. Kept apart from compute so shipping application code can
 * never propose replacing the bucket that holds every original.
 *
 * Four prefixes with four different trust levels (design.md D7):
 *
 *   staging/    untrusted uploads, never CDN-reachable, expired within a day
 *   original/   immutable sources, write-once, tiered down over time
 *   master/     optional bounded intermediates for very large sources
 *   derived/    delivery artifacts, the only prefix the distribution may read
 */

import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { bucketNameFor, type EnvironmentConfig } from './config.js';
import { addMalwareScanning } from './malware-scanning.js';

export const STAGING_PREFIX = 'staging/';
export const ORIGINAL_PREFIX = 'original/';
export const MASTER_PREFIX = 'master/';
export const DERIVED_PREFIX = 'derived/';

export interface StorageStackProps extends StackProps {
  config: EnvironmentConfig;
}

export class StorageStack extends Stack {
  readonly bucket: s3.Bucket;
  /** Access logs for the distribution, the load balancer, and the asset bucket. */
  readonly logBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { config } = props;

    /*
     * One bucket for every access log in the deployment.
     *
     * There were none at all, which meant incident forensics had aggregate metrics
     * and nothing else: no way to answer "which key", "from where", or "how did they
     * find it" — and the delivery plane is unauthenticated, so those are the only
     * questions worth asking about it.
     *
     * `OBJECT_WRITER` ownership rather than the account default: CloudFront's
     * standard logging and S3 server-access logging both write with an ACL, and a
     * bucket with ACLs disabled rejects them — at delivery time, silently, long after
     * a green deploy. Public access is still blocked and SSL still enforced.
     *
     * Expired rather than retained: logs are for the incident you are in, and a
     * never-expiring log bucket is the one storage line that grows with traffic
     * rather than with content.
     */
    this.logBucket = new s3.Bucket(this, 'LogBucket', {
      bucketName: `${bucketNameFor(config)}-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      removalPolicy: config.removalPolicy,
      lifecycleRules: [
        {
          id: 'expire-logs',
          expiration: Duration.days(config.storage.accessLogRetentionDays),
          abortIncompleteMultipartUploadAfter: Duration.days(
            config.storage.abortIncompleteMultipartDays,
          ),
        },
      ],
    });

    this.bucket = new s3.Bucket(this, 'AssetBucket', {
      bucketName: bucketNameFor(config),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      /*
       * Versioning, for one reason: originals cannot be regenerated.
       *
       * "Write-once" is enforced by code alone — no path reads an object under
       * `original/`, modifies it, and writes it back — and two roles can delete
       * there: maintenance, which reclaims superseded versions, and the API task
       * role, which backs `DELETE /v1/images/:id`. A defect in either destroys the
       * one thing in this system with no upstream copy. With versioning, the same
       * defect writes a delete marker and the bytes remain recoverable for
       * `noncurrentVersionExpiryDays`.
       *
       * The cost of that safety is that every delete now leaves a copy behind, which
       * is why each lifecycle rule below carries its own noncurrent expiry. A
       * versioned bucket without those rules grows forever and — worse — quietly
       * retains the untrusted bytes that `staging/`'s hard expiry exists to destroy.
       */
      versioned: true,
      removalPolicy: config.removalPolicy,
      // Object-level reads and writes on the asset bucket, so a takedown or a leak
      // can be traced to a principal rather than inferred.
      serverAccessLogsBucket: this.logBucket,
      serverAccessLogsPrefix: 's3/',
      lifecycleRules: [
        {
          /*
           * Untrusted bytes have a hard expiry rather than a cleanup job, so an
           * abandoned presigned upload cannot linger even if the reaper is broken.
           *
           * Under versioning, `expiration` only writes a delete marker — so this rule
           * without its noncurrent half would leave every expired upload, and every
           * object the malware quarantine handler deletes, sitting in the bucket as a
           * noncurrent version. That converts a security control into a retention
           * policy for exactly the bytes it exists to remove.
           */
          id: 'expire-staging',
          prefix: STAGING_PREFIX,
          expiration: Duration.days(config.storage.stagingExpiryDays),
          noncurrentVersionExpiration: Duration.days(config.storage.stagingNoncurrentExpiryDays),
          abortIncompleteMultipartUploadAfter: Duration.days(
            config.storage.abortIncompleteMultipartDays,
          ),
        },
        {
          // Originals are read only to generate from, which happens rarely after the
          // warm set exists. Both target classes are instant-retrieval: a class
          // needing a restore step would turn a cache miss into a failed request.
          id: 'tier-originals',
          prefix: ORIGINAL_PREFIX,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(config.storage.originalsInfrequentAccessDays),
            },
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: Duration.days(config.storage.originalsArchiveDays),
            },
          ],
        },
        {
          id: 'tier-masters',
          prefix: MASTER_PREFIX,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(config.storage.originalsInfrequentAccessDays),
            },
          ],
        },
        {
          // Applies to every prefix. Costs nothing and closes the case where a
          // multipart upload outside staging is abandoned.
          id: 'abort-incomplete-multipart',
          abortIncompleteMultipartUploadAfter: Duration.days(
            config.storage.abortIncompleteMultipartDays,
          ),
        },
        {
          /*
           * What versioning costs, bounded.
           *
           * Every delete and every overwrite anywhere in the bucket leaves the
           * previous copy as a noncurrent version. This is the recovery window for
           * originals — the reason versioning is on — and the ceiling that keeps
           * recovery copies from becoming a permanent second copy of the bucket.
           * `staging/` has its own, much shorter, rule above; S3 applies the most
           * specific matching rule, so this one governs everything else.
           *
           * `expiredObjectDeleteMarker` sweeps the markers left behind once the
           * versions under them are gone. They are zero bytes each, but they are also
           * what makes a `list-objects` walk slower and stranger over time, and the
           * orphan collector walks the whole bucket.
           */
          id: 'expire-noncurrent-versions',
          noncurrentVersionExpiration: Duration.days(config.storage.noncurrentVersionExpiryDays),
          expiredObjectDeleteMarker: true,
        },
      ],
    });

    // Deliberately no lifecycle rule on `derived/`. Derivatives stay in Standard:
    // every one of them is a potential cache miss, and the retrieval-priced classes
    // would add a per-request charge to exactly the path that must stay cheap.

    /*
     * "Deny unencrypted writes", carefully.
     *
     * The obvious policy — deny when `s3:x-amz-server-side-encryption` is absent —
     * denies *every* write this service makes. None of our callers set the header,
     * because the bucket's default encryption applies server-side and the request
     * simply does not carry it. That policy would break all uploads while looking
     * strict and correct in a review.
     *
     * What is actually wanted is to deny a caller who explicitly asks for something
     * other than encryption. Combined with default encryption above and `enforceSSL`,
     * every object is encrypted at rest and in transit.
     */
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyExplicitlyUnencryptedWrites',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [this.bucket.arnForObjects('*')],
        conditions: {
          StringNotEquals: { 's3:x-amz-server-side-encryption': ['AES256', 'aws:kms'] },
          Null: { 's3:x-amz-server-side-encryption': 'false' },
        },
      }),
    );

    /*
     * The distribution's read grant, written here rather than by the CDN stack.
     *
     * Two properties matter and both are deliberate:
     *
     * 1. **Only `derived/`.** Staging, originals, and masters are unreachable
     *    through the CDN because this policy never mentions them. A path traversal
     *    toward `original/` does not resolve, because there is no permission for it
     *    to resolve to.
     *
     * 2. **No `s3:ListBucket`.** Without list permission S3 reports a missing key as
     *    403 rather than 404 — which is precisely why the origin group fails over on
     *    403. Granting list here would change that status and quietly alter the
     *    delivery path's behaviour.
     *
     * 3. **Pinned to one distribution, when the id is known.** The condition falls
     *    back to "any distribution in this account", and that fallback is not
     *    immaterial: environments are otherwise fully isolated, but two of them in
     *    one account means staging's distribution satisfies production's condition
     *    and can read production's derivatives. The id is supplied out of band
     *    (`CDN_DISTRIBUTION_ID`, emitted by the CDN stack on first deploy) rather
     *    than referenced, because naming the construct would make storage depend on
     *    CDN, which depends on compute, which depends on storage — a cycle
     *    CloudFormation reports as a wall of unrelated resources.
     *
     *    So the first deploy of a new environment runs unpinned, and pinning is a
     *    second pass. Documented in the bootstrap guide rather than left as folklore.
     */
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontReadDerivativesOnly',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects(`${DERIVED_PREFIX}*`)],
        conditions:
          config.cdnDistributionId === undefined
            ? {
                StringLike: {
                  'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/*`,
                },
              }
            : {
                StringEquals: {
                  'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${config.cdnDistributionId}`,
                },
              },
      }),
    );

    if (config.malwareScanning) {
      addMalwareScanning(this, { environment: config.name, bucket: this.bucket });
    }

    new CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
    new CfnOutput(this, 'BucketArn', { value: this.bucket.bucketArn });
  }
}
