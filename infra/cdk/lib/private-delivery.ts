/**
 * Signed-URL delivery for private assets.
 *
 * Off by default, and a *separate cache behavior* rather than a setting on the
 * existing one. That is the whole design: turning on trusted key groups for the
 * default behavior would require a signature for every image in the deployment,
 * including the public ones, and there is no way to exempt them after the fact
 * without a second behavior anyway.
 *
 * So private assets live under their own path prefix, get their own behavior with
 * `trustedKeyGroups`, and share everything else — same origin group, same edge
 * normalizer, same cache policy. A viewer without a valid signature is refused at
 * the edge, before any origin or compute cost is incurred.
 *
 * The private key never appears here. CloudFront holds only the public half; the
 * control plane signs with the private half, delivered from the secret store.
 */

import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { PRIVATE_PATH_PREFIX } from '@imgopt/core';
import type { Construct } from 'constructs';

/**
 * Path prefix for signature-required delivery.
 *
 * A prefix rather than a per-asset flag because CloudFront matches behaviors by path
 * pattern and knows nothing about our metadata. An asset's privacy is therefore
 * expressed in its URL, which also means changing it mints a new URL — consistent
 * with everything else here being immutable.
 *
 * Read from core rather than spelled out, because three copies of this string exist:
 * the behavior below, the edge normalizer's prefix table, and the control plane's URL
 * builder. A behavior that matches a prefix the normalizer does not rewrite is
 * exactly the failure this deployment already had — signed URLs that verify, then
 * 403 at S3 and 400 at the generator.
 */
export const PRIVATE_PATH_PATTERN = `/${PRIVATE_PATH_PREFIX}/*`;

export interface PrivateDeliveryOptions {
  environment: string;
  /**
   * PEM-encoded public key whose private half the control plane signs with.
   *
   * Supplied as configuration rather than generated here: CDK cannot produce a key
   * pair without also putting the private half in the template, and a key CloudFront
   * has never seen is the one thing that cannot be rotated without a deploy.
   */
  publicKeyPem: string;
}

export interface PrivateDelivery {
  keyGroup: cloudfront.KeyGroup;
  pathPattern: string;
}

export function createPrivateDelivery(
  scope: Construct,
  options: PrivateDeliveryOptions,
): PrivateDelivery {
  const publicKey = new cloudfront.PublicKey(scope, 'PrivateDeliveryPublicKey', {
    publicKeyName: `imgopt-${options.environment}-private`,
    encodedKey: options.publicKeyPem,
    comment: 'Verifies signed URLs for private assets',
  });

  const keyGroup = new cloudfront.KeyGroup(scope, 'PrivateDeliveryKeyGroup', {
    keyGroupName: `imgopt-${options.environment}-private`,
    items: [publicKey],
    comment: 'Trusted signers for private asset delivery',
  });

  return { keyGroup, pathPattern: PRIVATE_PATH_PATTERN };
}
