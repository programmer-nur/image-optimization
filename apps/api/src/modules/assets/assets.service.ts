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
import { AssetRepository, type Asset, type FocalPoint, type ListAssetsOptions } from '@imgopt/db';
import { DERIVED_PREFIX, MASTER_PREFIX, ORIGINAL_PREFIX } from '@imgopt/core';
import { ASSET_REPOSITORY, LOGGER, QUEUE, STORAGE } from '../../tokens.js';
import { bindAssetId, requestContext } from '../../common/logger.js';
import { ApiError } from '../../common/errors.js';
import { UploadService, type UploadResult } from '../upload/upload.service.js';
import { InvalidationService } from './invalidation.service.js';

@Injectable()
export class AssetsService {
  constructor(
    @Inject(ASSET_REPOSITORY) private readonly repo: AssetRepository,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly uploads: UploadService,
    private readonly invalidation: InvalidationService,
  ) {}

  async get(assetId: string): Promise<Asset> {
    bindAssetId(assetId);
    return this.repo.requireById(assetId);
  }

  async currentVersion(assetId: string) {
    return this.repo.currentVersion(assetId);
  }

  async list(options: ListAssetsOptions) {
    return this.repo.list(options);
  }

  async listVariants(assetId: string) {
    await this.repo.requireById(assetId);
    return this.repo.listDerivatives(assetId);
  }

  /** Alt text and tags do not change bytes, so they must not bump the version. */
  async updateMetadata(
    assetId: string,
    input: { altText?: string | null; tags?: string[]; focalPoint?: FocalPoint | null },
  ): Promise<Asset> {
    bindAssetId(assetId);
    const before = await this.repo.requireById(assetId);

    await this.repo.updateMetadata(assetId, input);

    // A focal-point change alters focal-cropped output, so those derivatives must be
    // re-derived under a new version rather than serving stale crops.
    if (input.focalPoint !== undefined && before.currentVersion > 0) {
      await this.reprocess(assetId);
    }

    return this.repo.requireById(assetId);
  }

  async replaceSource(
    assetId: string,
    body: Readable,
    declaredType: string | undefined,
  ): Promise<UploadResult> {
    return this.uploads.replaceSourceStream(assetId, body, declaredType);
  }

  async reprocess(assetId: string): Promise<void> {
    bindAssetId(assetId);
    const asset = await this.repo.requireById(assetId);
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

  async delete(assetId: string): Promise<void> {
    bindAssetId(assetId);
    await this.repo.requireById(assetId);

    // Soft-delete first: the row records the intent, so a partial object cleanup is
    // reconciled later rather than leaving an asset that is half-deleted and still
    // servable.
    await this.repo.softDelete(assetId);

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
