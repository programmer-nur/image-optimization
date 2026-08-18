/**
 * Asset lifecycle: read, update, replace, reprocess, delete.
 *
 * The delete path is the interesting one. It removes objects across every prefix and
 * every version, invalidates the CDN, and soft-deletes the row. Object removal is
 * recorded as intent even on partial failure — the orphan collector reconciles
 * leftovers later — so a delete is never lost to a transient S3 error.
 */

import { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { StoragePort } from '@imgopt/storage';
import type { QueuePort } from '@imgopt/queue';
import {
  TenantScopedRepository,
  type Asset,
  type FocalPoint,
  type ListAssetsOptions,
  type TenantScope,
} from '@imgopt/db';
import { DERIVED_PREFIX, MASTER_PREFIX, ORIGINAL_PREFIX } from '@imgopt/core';
import { ASSET_REPOSITORY, LOGGER, QUEUE, STORAGE } from '../../tokens.js';
import { bindAssetId, requestContext } from '../../common/logger.js';
import { ApiError } from '../../common/errors.js';
import { UploadService, type UploadResult } from '../upload/upload.service.js';
import { InvalidationService } from './invalidation.service.js';

@Injectable()
export class AssetsService {
  constructor(
    @Inject(ASSET_REPOSITORY) private readonly repo: TenantScopedRepository,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly uploads: UploadService,
    private readonly invalidation: InvalidationService,
  ) {}

  async get(scope: TenantScope, assetId: string): Promise<Asset> {
    bindAssetId(assetId);
    return this.repo.requireById(scope, assetId);
  }

  async currentVersion(scope: TenantScope, assetId: string) {
    return this.repo.currentVersion(scope, assetId);
  }

  async list(scope: TenantScope, options: ListAssetsOptions) {
    return this.repo.list(scope, options);
  }

  async listVariants(scope: TenantScope, assetId: string) {
    return this.repo.listDerivatives(scope, assetId);
  }

  /**
   * Metadata changes no bytes, so none of it bumps the version.
   *
   * That includes the focal point, which used to enqueue a reprocess here. The
   * reprocess did nothing observable and cost a Lambda invocation to discover it:
   * `crop=focal` rendered as centre, so the focal derivative was byte-identical to
   * the plain one, and the optimizer skips keys that already exist. `focal` has since
   * left the URL grammar for the same underlying reason — the delivery plane never
   * reads the registry, so a stored point cannot reach the render. The value is kept
   * as advisory metadata for consumers that position images themselves (CSS
   * `object-position` and the like), and is documented as exactly that.
   */
  async updateMetadata(
    scope: TenantScope,
    assetId: string,
    input: { altText?: string | null; tags?: string[]; focalPoint?: FocalPoint | null },
  ): Promise<Asset> {
    bindAssetId(assetId);
    // The scoped update checks existence-within-tenant itself, so an id belonging to
    // anyone else is a 404 before any write is attempted.
    await this.repo.updateMetadata(scope, assetId, input);

    return this.repo.requireById(scope, assetId);
  }

  async replaceSource(
    scope: TenantScope,
    assetId: string,
    body: Readable,
    declaredType: string | undefined,
    apiKeyId: string | undefined,
  ): Promise<UploadResult> {
    return this.uploads.replaceSourceStream(scope, assetId, body, declaredType, apiKeyId);
  }

  async reprocess(scope: TenantScope, assetId: string): Promise<void> {
    bindAssetId(assetId);
    const asset = await this.repo.requireById(scope, assetId);
    if (asset.currentVersion === 0) {
      throw ApiError.conflict('Cannot reprocess an asset with no stored source.');
    }

    const correlationId = requestContext.getStore()?.correlationId ?? assetId;
    await this.queue.enqueue({
      assetId,
      assetVersion: asset.currentVersion,
      correlationId,
      reprocess: true,
    });
  }

  async delete(scope: TenantScope, assetId: string): Promise<void> {
    bindAssetId(assetId);

    // Soft-delete first: the row records the intent, so a partial object cleanup is
    // reconciled later rather than leaving an asset that is half-deleted and still
    // servable. Scoped, so it also serves as the ownership check — the prefix
    // deletions below are by asset id alone and would otherwise reach any tenant's
    // objects.
    await this.repo.softDelete(scope, assetId);

    const prefixes = [
      `${ORIGINAL_PREFIX}/${assetId}/`,
      `${MASTER_PREFIX}/${assetId}/`,
      `${DERIVED_PREFIX}/${assetId}/`,
    ];
    let removed = 0;
    for (const prefix of prefixes) {
      try {
        removed += await this.storage.deletePrefix(prefix);
      } catch (error) {
        this.logger.error({ err: error, assetId, prefix }, 'object cleanup failed; will reconcile');
      }
    }

    await this.invalidation.invalidateAsset(assetId).catch((error: unknown) => {
      this.logger.error({ err: error, assetId }, 'CDN invalidation failed');
    });

    this.logger.info({ assetId, objectsRemoved: removed }, 'asset deleted');
  }
}
