/**
 * CDN invalidation.
 *
 * Invalidation is reserved for deletions and takedowns — routine content changes use
 * a new versioned URL, never invalidation (design.md D8). When no distribution is
 * configured (local development, or before the CDN stack exists) this logs the
 * intent and returns, so the delete path works end-to-end without CloudFront.
 */

import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { AppConfig } from '@imgopt/config';
import { APP_CONFIG, LOGGER } from '../../tokens.js';

@Injectable()
export class InvalidationService {
  private readonly distributionId: string | undefined;
  private readonly client: CloudFrontClient | undefined;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.distributionId = config.delivery.distributionId;
    this.client = this.distributionId !== undefined ? new CloudFrontClient({}) : undefined;
  }

  /** Invalidates every delivery path for one asset. */
  async invalidateAsset(assetId: string): Promise<void> {
    const path = `/i/${assetId}/*`;

    if (this.client === undefined || this.distributionId === undefined) {
      this.logger.info({ assetId, path }, 'CDN invalidation skipped (no distribution configured)');
      return;
    }

    await this.client.send(
      new CreateInvalidationCommand({
        DistributionId: this.distributionId,
        InvalidationBatch: {
          CallerReference: `${assetId}-${Date.now()}`,
          Paths: { Quantity: 1, Items: [path] },
        },
      }),
    );
    this.logger.info({ assetId, path }, 'CDN invalidation requested');
  }
}
