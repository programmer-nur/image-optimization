/**
 * Signed URLs for private assets.
 *
 * Disabled unless a key pair is configured, and disabled *loudly*: asking for a
 * signed URL when signing is not set up throws rather than returning an unsigned one.
 * A silent fallback would hand out a URL that works — because the private behavior
 * would refuse it and the public one would serve it — and the asset would be public
 * while the code path claiming to protect it reported success.
 *
 * Private assets are served from their own path prefix, which is how CloudFront
 * decides that a signature is required at all: behaviors match on path, and know
 * nothing about our metadata. See `infra/cdk/lib/private-delivery.ts`.
 */

import { Inject, Injectable } from '@nestjs/common';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import type { AppConfig } from '@imgopt/config';
import { toVersionSegment } from '@imgopt/core';
import { APP_CONFIG } from '../../tokens.js';

/** Must match `PRIVATE_PATH_PATTERN` in the CDN stack. */
export const PRIVATE_PATH_PREFIX = 'p';

export interface SignOptions {
  /** Seconds from now. Defaults to the configured TTL. */
  expiresInSeconds?: number;
}

@Injectable()
export class SignedUrlService {
  private readonly cdnHost: string;
  private readonly encoderEpoch: number;
  private readonly keyPairId: string | undefined;
  private readonly privateKey: string | undefined;
  private readonly defaultTtl: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.cdnHost = config.delivery.cdnHost;
    this.encoderEpoch = config.delivery.encoderEpoch;
    this.keyPairId = config.delivery.signedUrlKeyPairId;
    this.defaultTtl = config.delivery.signedUrlTtlSeconds;

    // A PEM carried through an environment variable usually arrives with literal
    // `\n` rather than real newlines, which the signer rejects with an unhelpful
    // parse error. Normalizing here beats debugging it at the first signature.
    this.privateKey = config.delivery.signedUrlPrivateKey?.replace(/\\n/g, '\n');
  }

  get enabled(): boolean {
    return this.keyPairId !== undefined && this.privateKey !== undefined;
  }

  /** Base URL under the signature-required prefix. */
  privateBaseUrl(assetId: string, assetVersion: number): string {
    const scheme = this.cdnHost.startsWith('localhost') ? 'http' : 'https';
    const version = toVersionSegment(assetVersion, this.encoderEpoch);
    return `${scheme}://${this.cdnHost}/${PRIVATE_PATH_PREFIX}/${assetId}/${version}`;
  }

  /**
   * Signs a delivery URL.
   *
   * The signature covers the full URL including its query string, so a viewer cannot
   * change `?w=` on a signed link and get a different rendition — each transform of a
   * private asset needs its own signature. That is the point, and it is also why a
   * short TTL is the default: a leaked signed URL is a bearer token for exactly one
   * variant until it expires.
   */
  sign(url: string, options: SignOptions = {}): string {
    if (this.keyPairId === undefined || this.privateKey === undefined) {
      throw new Error(
        'Signed-URL delivery is not configured. Set SIGNED_URL_KEY_PAIR_ID and ' +
          'SIGNED_URL_PRIVATE_KEY, and deploy a key group (PRIVATE_DELIVERY_PUBLIC_KEY).',
      );
    }

    const ttl = options.expiresInSeconds ?? this.defaultTtl;

    return getSignedUrl({
      url,
      keyPairId: this.keyPairId,
      privateKey: this.privateKey,
      dateLessThan: new Date(Date.now() + ttl * 1000).toISOString(),
    });
  }

  /** Convenience: a signed URL for one asset version at one width. */
  signForAsset(
    assetId: string,
    assetVersion: number,
    query: string,
    options: SignOptions = {},
  ): string {
    const base = this.privateBaseUrl(assetId, assetVersion);
    return this.sign(query === '' ? base : `${base}?${query}`, options);
  }
}
