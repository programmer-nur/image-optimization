/**
 * Upload orchestration.
 *
 * Both ingest modes converge on one invariant: untrusted bytes land in the private
 * `staging/` prefix, are validated there, and are promoted to the immutable
 * `original/` prefix only after every check passes. This is what reconciles "never
 * fail on a large upload" with "validate before storing" — direct-to-S3 uploads
 * cannot be validated before storage, so they are validated after, in a location
 * that is private, CDN-unreachable, and lifecycle-expired. See design.md D2.
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { AppConfig } from '@imgopt/config';
import type { StoragePort, PresignedUploadTarget } from '@imgopt/storage';
import type { QueuePort } from '@imgopt/queue';
import {
  TenantScopedRepository,
  type Asset,
  type RejectionReason,
  type TenantScope,
} from '@imgopt/db';
import { toOriginalKey, toStagingKey, FORMAT_EXTENSIONS } from '@imgopt/core';
import { APP_CONFIG, ASSET_REPOSITORY, LOGGER, QUEUE, STORAGE } from '../../tokens.js';
import { requestContext, bindAssetId } from '../../common/logger.js';
import { ApiError } from '../../common/errors.js';
import { recordUpload, recordUploadRejection } from '@imgopt/metrics';
import { ApiKeyService } from '../auth/api-key.service.js';
import { ValidationService, type DetectedFormat } from './validation.service.js';
import { MalwareScanService } from './malware-scan.service.js';

const HEADER_BYTES = 65_535;

/**
 * API error code to registry rejection reason.
 *
 * The two vocabularies are not the same and never were: the HTTP surface calls an
 * oversize upload `payload_too_large`, the registry calls it `file_too_large`. This
 * used to be a membership test against the registry's names, so the one code that
 * differs failed the test and fell through to the catch-all — every oversize
 * rejection recorded, and metered, as `unsupported_format`. That is the exact
 * dimension the observability spec designates for telling a consuming application's
 * bug apart from someone probing the uploader, so a mistranslation there is worse
 * than no dimension at all.
 *
 * An explicit table instead, because the failure was silent: an unmapped code now
 * lands on `unknown` rather than borrowing a reason that means something else.
 */
const REJECTION_REASON_BY_CODE: Record<string, RejectionReason> = {
  content_type_mismatch: 'content_type_mismatch',
  unsupported_format: 'unsupported_format',
  pixel_limit_exceeded: 'pixel_limit_exceeded',
  payload_too_large: 'file_too_large',
  file_too_large: 'file_too_large',
  empty_file: 'empty_file',
  quota_exceeded: 'quota_exceeded',
  malware_detected: 'malware_detected',
};

function rejectionReasonFor(error: unknown): RejectionReason {
  if (!(error instanceof ApiError)) return 'unknown';
  return REJECTION_REASON_BY_CODE[error.code] ?? 'unknown';
}

/** file-type ext for our detected formats, for the original object key. */
const FORMAT_EXTENSION: Record<DetectedFormat, string> = {
  jpeg: FORMAT_EXTENSIONS.jpeg,
  png: FORMAT_EXTENSIONS.png,
  webp: FORMAT_EXTENSIONS.webp,
  avif: FORMAT_EXTENSIONS.avif,
  gif: 'gif',
  tiff: 'tiff',
};

export interface UploadResult {
  asset: Asset;
  duplicate: boolean;
  /**
   * Set when the bytes passed validation but are waiting on a malware verdict.
   *
   * The asset stays `pending_upload` and the bytes stay in staging, which is exactly
   * what those already mean — no new status is needed to express "held".
   */
  held?: { reason: string };
}

@Injectable()
export class UploadService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(ASSET_REPOSITORY) private readonly repo: TenantScopedRepository,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly validation: ValidationService,
    private readonly keys: ApiKeyService,
    private readonly scans: MalwareScanService,
  ) {}

  /** Proxied path: stream the request body straight into staging, then validate. */
  async ingestStream(
    scope: TenantScope,
    body: Readable,
    declaredType: string | undefined,
    apiKeyId: string | undefined,
    options: { altText?: string; tags?: string[] } = {},
  ): Promise<UploadResult> {
    const asset = await this.repo.create(scope, {
      ...(apiKeyId !== undefined ? { apiKeyId } : {}),
      ...(options.altText !== undefined ? { altText: options.altText } : {}),
      ...(options.tags !== undefined ? { tags: options.tags } : {}),
    });
    bindAssetId(asset.id);

    const stagingKey = toStagingKey(asset.id);
    await this.storage.put(stagingKey, body, {
      ...(declaredType !== undefined ? { contentType: declaredType } : {}),
    });

    return this.validateAndPromote(scope, asset, stagingKey, declaredType, apiKeyId, {
      dedup: true,
    });
  }

  /**
   * Replaces an existing asset's source, minting a new version.
   *
   * Deduplication is off here: the caller explicitly wants a new version of *this*
   * asset, not to be redirected to whichever other asset happens to share the bytes.
   */
  async replaceSourceStream(
    scope: TenantScope,
    assetId: string,
    body: Readable,
    declaredType: string | undefined,
    apiKeyId: string | undefined,
  ): Promise<UploadResult> {
    bindAssetId(assetId);
    const asset = await this.repo.requireById(scope, assetId);

    const stagingKey = toStagingKey(`${assetId}-${Date.now()}`);
    await this.storage.put(stagingKey, body, {
      ...(declaredType !== undefined ? { contentType: declaredType } : {}),
    });

    /*
     * The *caller's* key pays for these bytes, not the key that first created the
     * asset. Charging `asset.apiKeyId` meant any key holding `upload` could replace
     * another key's source and have the bytes billed to that other key's quota —
     * spending an allowance it does not hold and never touching its own.
     */
    return this.validateAndPromote(scope, asset, stagingKey, declaredType, apiKeyId, {
      dedup: false,
    });
  }

  /** Presigned path: hand back an upload target; the client writes to S3 directly. */
  async createUploadTarget(
    scope: TenantScope,
    declaredType: string,
    apiKeyId: string | undefined,
    options: { altText?: string; tags?: string[] } = {},
  ): Promise<{ asset: Asset; target: PresignedUploadTarget }> {
    const asset = await this.repo.create(scope, {
      ...(apiKeyId !== undefined ? { apiKeyId } : {}),
      ...(options.altText !== undefined ? { altText: options.altText } : {}),
      ...(options.tags !== undefined ? { tags: options.tags } : {}),
    });
    bindAssetId(asset.id);

    const target = await this.storage.presignUpload(toStagingKey(asset.id), {
      minBytes: 1,
      maxBytes: this.config.upload.maxFileBytes,
      contentType: declaredType,
      expiresInSeconds: this.config.upload.presignTtlSeconds,
    });

    return { asset, target };
  }

  /** Presigned path, second step: validate what the client uploaded, then promote. */
  async completeUpload(
    scope: TenantScope,
    assetId: string,
    declaredType: string | undefined,
    apiKeyId: string | undefined,
  ): Promise<UploadResult> {
    bindAssetId(assetId);
    const asset = await this.repo.findById(scope, assetId, { includeDeleted: true });
    if (asset === null) throw ApiError.notFound(`No upload with id "${assetId}".`);
    if (asset.currentVersion > 0) {
      throw ApiError.conflict('This upload has already been completed.');
    }

    const stagingKey = toStagingKey(assetId);
    const head = await this.storage.head(stagingKey);
    if (head === undefined) {
      throw ApiError.notFound('No uploaded bytes found for this id. Did the upload finish?');
    }

    // Same rule as above: quota is the completing caller's, since completion is what
    // makes the bytes durable and is the step that must have headroom.
    return this.validateAndPromote(scope, asset, stagingKey, declaredType, apiKeyId, {
      dedup: true,
    });
  }

  private async validateAndPromote(
    scope: TenantScope,
    asset: Asset,
    stagingKey: string,
    declaredType: string | undefined,
    apiKeyId: string | undefined,
    options: { dedup: boolean },
  ): Promise<UploadResult> {
    const head = await this.storage.head(stagingKey);
    if (head === undefined) {
      throw ApiError.notFound('Staged upload disappeared before validation.');
    }

    let result;
    try {
      const header = await this.storage.getRange(
        stagingKey,
        0,
        Math.min(HEADER_BYTES, Math.max(head.bytes - 1, 0)),
      );
      result = await this.validation.validate(header, head.bytes, declaredType);
    } catch (error) {
      await this.reject(scope, asset.id, stagingKey, error);
      throw error;
    }

    /*
     * Malware verdict, before anything is promoted or charged against a quota.
     *
     * A threat is terminal: the staged object is deleted and the asset is rejected.
     * An *unavailable* verdict is the interesting case, because scanning is
     * asynchronous and "not scanned yet" looks identical to "scanner is broken". Under
     * the fail-closed policy the upload is held rather than rejected — the caller is
     * told, the asset stays `pending_upload`, and the bytes stay in staging where the
     * lifecycle rule will expire them if nothing ever resolves it. Rejecting instead
     * would fail most legitimate uploads; promoting would make the scanner decorative.
     */
    const verdict = await this.scans.verdictFor(stagingKey);

    if (verdict.status === 'threat') {
      this.logger.warn(
        { assetId: asset.id, detail: verdict.detail },
        'malware detected in staged upload',
      );
      recordUploadRejection('malware_detected', { assetId: asset.id });
      await this.storage.delete(stagingKey).catch(() => undefined);
      await this.repo.markRejected(scope, asset.id, 'malware_detected').catch(() => undefined);
      throw ApiError.malwareDetected();
    }

    if (verdict.status === 'unavailable' && this.scans.holdsWithoutVerdict) {
      this.logger.info(
        { assetId: asset.id, detail: verdict.detail },
        'upload held pending malware verdict',
      );
      return { asset, duplicate: false, held: { reason: verdict.detail } };
    }

    // Reserve quota only once the bytes are known-valid, so an invalid upload never
    // consumes a slot.
    let reserved = false;
    if (apiKeyId !== undefined) {
      await this.keys.reserveQuota(apiKeyId, result.bytes);
      reserved = true;
    }

    try {
      const hash = await this.hashStaged(stagingKey);

      // Scoped: a match is only a duplicate if *this* tenant already holds those
      // bytes. Matching deployment-wide would hand one tenant a reference to another's
      // asset and disclose that the other holds exactly these bytes.
      const existing = options.dedup ? await this.repo.findByContentHash(scope, hash) : null;
      if (existing !== null && existing.assetId !== asset.id) {
        // Identical bytes already stored: discard this upload and hand back the
        // original. A re-upload is common — a CMS retry, a double-click.
        await this.storage.delete(stagingKey);
        if (reserved && apiKeyId !== undefined)
          await this.keys.releaseQuota(apiKeyId, result.bytes);
        await this.repo.softDelete(scope, asset.id);
        const original = await this.repo.requireById(scope, existing.assetId);
        return { asset: original, duplicate: true };
      }

      const originalKey = toOriginalKey(
        asset.id,
        asset.currentVersion + 1,
        FORMAT_EXTENSION[result.format],
      );
      await this.storage.copy(stagingKey, originalKey);

      const stored = await this.repo.addVersion(scope, {
        assetId: asset.id,
        sourceKey: originalKey,
        contentHash: hash,
        metadata: {
          format: result.format,
          bytes: result.bytes,
          ...(result.width > 0 ? { width: result.width } : {}),
          ...(result.height > 0 ? { height: result.height } : {}),
        },
      });

      await this.enqueueOptimize(asset.id, stored.version);
      await this.storage.delete(stagingKey);

      const promoted = await this.repo.requireById(scope, asset.id);
      recordUpload(result.bytes, result.format);
      this.logger.info({ assetId: asset.id, format: result.format }, 'upload stored');
      return { asset: promoted, duplicate: false };
    } catch (error) {
      if (reserved && apiKeyId !== undefined) {
        await this.keys.releaseQuota(apiKeyId, result.bytes).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * Enqueue must never fail the upload: the bytes are already durable. A failure
   * here is logged and metered, and a reconciliation job re-enqueues the missing
   * work later. See design.md D2.
   */
  private async enqueueOptimize(assetId: string, version: number): Promise<void> {
    const correlationId = requestContext.getStore()?.correlationId ?? assetId;
    try {
      await this.queue.enqueue({ assetId, assetVersion: version, correlationId });
    } catch (error) {
      this.logger.error({ err: error, assetId }, 'failed to enqueue optimization; will reconcile');
    }
  }

  private async reject(
    scope: TenantScope,
    assetId: string,
    stagingKey: string,
    error: unknown,
  ): Promise<void> {
    await this.storage.delete(stagingKey).catch(() => undefined);
    const reason = rejectionReasonFor(error);

    // The reason dimension is what separates "a consuming application shipped a bug"
    // from "someone is probing the uploader" — same total, opposite responses.
    recordUploadRejection(reason, { assetId });
    await this.repo.markRejected(scope, assetId, reason).catch(() => undefined);
  }

  private async hashStaged(stagingKey: string): Promise<string> {
    // Streams the staged object through SHA-256 with bounded memory. For very large
    // presigned uploads this re-reads the object; deferring the hash to the worker
    // is the escape hatch if that read ever matters.
    const hash = createHash('sha256');
    const stream = await this.storage.getStream(stagingKey);
    await pipeline(stream, async function (source) {
      for await (const chunk of source) hash.update(chunk as Buffer);
    });
    return hash.digest('hex');
  }
}
