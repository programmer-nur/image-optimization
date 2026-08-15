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

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.bucket = new s3.Bucket(this, 'AssetBucket', {
      bucketName: bucketNameFor(config),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: config.removalPolicy,
      lifecycleRules: [
        {
          // Untrusted bytes have a hard expiry rather than a cleanup job, so an
          // abandoned presigned upload cannot linger even if the reaper is broken.
          id: 'expire-staging',
          prefix: STAGING_PREFIX,
          expiration: Duration.days(config.storage.stagingExpiryDays),
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
     * The source condition is scoped to distributions in this account rather than to
     * one distribution id. Naming the id would make this stack reference the CDN
     * stack, which references compute, which references this one. In a single-tenant
     * deployment with one distribution the difference is immaterial; the cycle is
     * not.
     */
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontReadDerivativesOnly',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects(`${DERIVED_PREFIX}*`)],
        conditions: {
          StringLike: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/*`,
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
