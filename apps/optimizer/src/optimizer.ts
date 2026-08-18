/**
 * Optimization worker.
 *
 * Runs the eager warm set for a newly stored asset: intrinsic metadata, an inline
 * LQIP, a conditional master for very large sources, and a small set of derivatives
 * so the common render path is never cold. Everything else is generated lazily on
 * first request by the generator Lambda (design.md D6).
 *
 * Kept free of Lambda types so it tests against real MinIO and Postgres directly.
 * The handler is the only Lambda-aware layer.
 */

import type { StoragePort } from '@imgopt/storage';
import type { OptimizeJob } from '@imgopt/queue';
import type { UnscopedAssetRepository } from '@imgopt/db';
import { DerivativeOrigin } from '@imgopt/db';
import type { AppConfig } from '@imgopt/config';
import {
  DEFAULT_QUALITY,
  FORMAT_MIME_TYPES,
  capToSource,
  snapUp,
  toCanonicalKey,
  toMasterKey,
  type TransformSpec,
} from '@imgopt/core';
import {
  ProcessingError,
  classifyError,
  generateLqip,
  generateMaster,
  needsMaster,
  readDominantColor,
  readMetadata,
} from '@imgopt/core/pipeline';
import { render } from '@imgopt/core/pipeline';
import { recordGeneration, recordOptimizeJob } from '@imgopt/metrics';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Immutable, one-year cache directive written alongside every derivative. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

export type ProcessOutcome =
  | { status: 'processed'; derivatives: number }
  /** Nothing to do — asset gone, deleted, or the job is for a superseded version. */
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; retriable: boolean; reason: string };

export class Optimizer {
  constructor(
    private readonly storage: StoragePort,
    private readonly repo: UnscopedAssetRepository,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async process(job: OptimizeJob): Promise<ProcessOutcome> {
    const startedAt = Date.now();
    const asset = await this.repo.findById(job.assetId, { includeDeleted: true });
    if (asset === null) return { status: 'skipped', reason: 'asset_not_found' };
    if (asset.deletedAt !== null) return { status: 'skipped', reason: 'asset_deleted' };

    // A job for a version the asset has since moved past is stale — the source was
    // replaced. Ignore it rather than regenerating superseded derivatives.
    if (job.assetVersion !== asset.currentVersion) {
      return { status: 'skipped', reason: 'stale_version' };
    }

    const version = await this.repo.currentVersion(job.assetId);
    if (version === null) return { status: 'skipped', reason: 'no_version' };

    try {
      const original = await this.storage.get(version.sourceKey);
      const meta = await readMetadata(original, { maxPixels: this.config.upload.maxPixels });

      // Animation does not survive the pipeline: the transform grammar describes a
      // still image, so every derivative is the opening frame re-encoded. Logged
      // where it is first known, because the alternative is discovering it from a
      // rendered page and having nothing in the record that says why.
      if (meta.isAnimated) {
        this.logger.warn(
          { assetId: job.assetId, format: meta.format, pages: meta.pages },
          'animated source; derivatives will carry the first frame only',
        );
      }

      /*
       * Conditional master: convert every future miss from "decode the full original"
       * to "decode a bounded intermediate". Only worth it for very large sources.
       *
       * Key and size travel together in one variable so the size cannot be recorded
       * without the object it measures. A master row with a key and no bytes is
       * indistinguishable from one written before the column existed, and that is
       * exactly the row the storage totals silently drop.
       */
      let master: { key: string; bytes: number } | undefined;
      let decodeSource = original;
      if (
        needsMaster(meta, {
          bytes: this.config.processing.masterThresholdBytes,
          longestEdge: this.config.processing.masterThresholdLongestEdge,
        })
      ) {
        const rendition = await generateMaster(original, {
          longestEdge: this.config.processing.masterLongestEdge,
          maxPixels: this.config.upload.maxPixels,
        });
        master = {
          key: toMasterKey(job.assetId, version.version),
          bytes: rendition.length,
        };
        await this.storage.put(master.key, rendition, { contentType: 'image/webp' });
        decodeSource = rendition;
      }

      // Both decode the source in full, so both carry the configured pixel ceiling.
      const [lqip, dominantColor] = await Promise.all([
        generateLqip(original, {
          width: this.config.processing.lqipWidth,
          maxPixels: this.config.upload.maxPixels,
        }),
        readDominantColor(original, { maxPixels: this.config.upload.maxPixels }).catch(
          () => undefined,
        ),
      ]);

      await this.repo.updateVersionMetadata(job.assetId, version.version, {
        width: meta.width,
        height: meta.height,
        format: meta.format,
        bytes: meta.bytes,
        hasAlpha: meta.hasAlpha,
        colorspace: meta.colorspace,
        ...(meta.orientation !== undefined ? { orientation: meta.orientation } : {}),
        ...(dominantColor !== undefined ? { dominantColor } : {}),
        lqip,
        ...(master !== undefined ? { masterKey: master.key, masterBytes: master.bytes } : {}),
      });

      const derivatives = await this.generateWarmSet(
        job,
        version.version,
        meta.width,
        decodeSource,
      );

      await this.repo.markReady(job.assetId);
      recordOptimizeJob({ durationMs: Date.now() - startedAt, derivatives });
      this.logger.info(
        {
          assetId: job.assetId,
          version: version.version,
          derivatives,
          master: master !== undefined,
        },
        'optimization complete',
      );
      return { status: 'processed', derivatives };
    } catch (error) {
      const classified = error instanceof ProcessingError ? error : classifyError(error);

      recordOptimizeJob({
        durationMs: Date.now() - startedAt,
        derivatives: 0,
        failed: true,
        reason: classified.code,
      });

      if (!classified.retriable) {
        // Terminal: retrying cannot help. Record it and let the message be acked.
        await this.repo
          .markFailed(job.assetId, this.mapReason(classified.code))
          .catch(() => undefined);
        this.logger.error(
          { assetId: job.assetId, code: classified.code },
          'optimization failed (terminal)',
        );
        return { status: 'failed', retriable: false, reason: classified.code };
      }

      // Retriable: leave the asset `stored` so a retry can complete it.
      this.logger.warn(
        { assetId: job.assetId, code: classified.code },
        'optimization failed (retriable)',
      );
      return { status: 'failed', retriable: true, reason: classified.code };
    }
  }

  /**
   * Generates the configured warm set.
   *
   * Widths are capped at the source rather than skipped, so a small source still
   * gets a warm derivative at its own size instead of nothing. Capping can collapse
   * several configured widths onto one, so the effective set is deduplicated — no
   * point rendering the same key twice.
   */
  private async generateWarmSet(
    job: OptimizeJob,
    version: number,
    sourceWidth: number,
    decodeSource: Buffer,
  ): Promise<number> {
    const widths = new Set<number>();
    for (const configured of this.config.processing.warmWidths) {
      widths.add(capToSource(snapUp(configured), sourceWidth));
    }

    const encoderEpoch = this.config.delivery.encoderEpoch;
    let count = 0;

    for (const width of widths) {
      for (const format of this.config.processing.warmFormats) {
        const spec: TransformSpec = { width, format, quality: DEFAULT_QUALITY };
        const key = toCanonicalKey({
          assetId: job.assetId,
          assetVersion: version,
          encoderEpoch,
          spec,
        });

        // Skip work that already exists (idempotent reprocessing, or a lazily
        // generated variant that beat us to it).
        if (await this.storage.exists(key)) {
          count += 1;
          continue;
        }

        const renderStartedAt = Date.now();
        const result = await render(decodeSource, spec, {
          maxPixels: this.config.upload.maxPixels,
        });

        // Marked `warm`, not `ondemand`. The warm set runs behind a queue with
        // nobody waiting, so counting it as on-demand would put a permanent floor
        // under the metric that exists to detect edge/core drift.
        recordGeneration({
          format,
          width,
          durationMs: Date.now() - renderStartedAt,
          bytes: result.bytes,
          source: 'warm',
          assetId: job.assetId,
          canonicalKey: key,
        });

        const written = await this.storage.putIfAbsent(key, result.data, {
          contentType: FORMAT_MIME_TYPES[format],
          cacheControl: IMMUTABLE_CACHE,
        });

        // Bookkeeping is best-effort: the delivery path never reads it, so a failed
        // write here must not fail the job.
        await this.repo
          .recordDerivative({
            canonicalKey: key,
            assetId: job.assetId,
            version,
            format,
            width: result.width,
            height: result.height,
            bytes: result.bytes,
            generatedBy: DerivativeOrigin.warm,
          })
          .catch((error: unknown) => {
            this.logger.warn({ err: error, key }, 'derivative bookkeeping failed');
          });

        if (written.written) count += 1;
      }
    }

    return count;
  }

  private mapReason(code: string): 'corrupt_source' | 'timeout' | 'storage_error' | 'unexpected' {
    switch (code) {
      case 'corrupt_source':
      case 'pixel_limit_exceeded':
      case 'unsupported_input':
        return 'corrupt_source';
      case 'timeout':
        return 'timeout';
      default:
        return 'unexpected';
    }
  }
}
