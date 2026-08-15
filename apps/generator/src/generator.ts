/**
 * On-demand derivative generation.
 *
 * Reached only through CloudFront origin failover: the edge function rewrites the
 * viewer's request to a canonical derivative path, CloudFront asks S3 for that exact
 * key, and when S3 reports it missing the same path is retried against this Lambda.
 * So a request arriving here means "this variant has never been generated" — it runs
 * at most once per variant per asset version, not once per request. See design.md D5.
 *
 * Two things follow from where it sits, and they shape everything below:
 *
 * - **The path is the entire input.** No query string (the edge dropped it), no
 *   asset metadata, no database — the delivery plane never queries PostgreSQL. Every
 *   render decision is recovered from the key, which is why the key is reversible.
 *
 * - **The response must be indistinguishable from S3's.** The first viewer is served
 *   by this function and every later viewer by the stored object. If the headers
 *   differ, the first viewer caches on different terms than everyone else.
 *
 * Kept free of Lambda types so it can be exercised against real storage directly;
 * `handler.ts` is the only Lambda-aware layer.
 */

import type { StoragePort } from '@imgopt/storage';
import type { AppConfig } from '@imgopt/config';
import {
  FORMAT_MIME_TYPES,
  parseCanonicalKey,
  toCanonicalKey,
  toMasterKey,
  toOriginalPrefix,
  type OutputFormat,
  type TransformSpec,
} from '@imgopt/core';
import { ProcessingError, classifyError, renderWithTimeout } from '@imgopt/core/pipeline';
import { recordGeneration, recordGenerationFailure } from '@imgopt/metrics';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Best-effort bookkeeping sink.
 *
 * Narrow on purpose: the delivery path must not depend on the database being
 * reachable, and the generator must not grow a Prisma import. `handler.ts` supplies
 * an implementation; every failure is swallowed. See design.md D11.
 */
export type RecordDerivative = (record: {
  canonicalKey: string;
  assetId: string;
  version: number;
  format: OutputFormat;
  width: number;
  height: number;
  bytes: number;
}) => Promise<unknown>;

/** Identical to what the optimizer writes, so stored and generated agree. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/**
 * Short, so a fixed URL or a later upload recovers quickly rather than being
 * pinned behind a year-long negative cache. See design.md D8.
 */
export const ERROR_CACHE = 'public, max-age=60';

/** Generation failures are never persisted at the edge — the next request retries. */
export const NO_STORE = 'no-store';

export interface GeneratorResponse {
  status: number;
  headers: Record<string, string>;
  /** Absent on errors, which carry a short JSON body instead. */
  body?: Buffer;
  /** Set on errors. */
  error?: { code: string; message: string };
}

export class Generator {
  constructor(
    private readonly storage: StoragePort,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly record?: RecordDerivative,
  ) {}

  async generate(path: string): Promise<GeneratorResponse> {
    const parsed = parseCanonicalKey(path);
    if (!parsed.ok) {
      return this.clientError(400, parsed.reason, `Not a canonical derivative path: "${path}".`);
    }

    const { assetId, assetVersion, encoderEpoch, spec } = parsed.parts;

    // Refuse to mint objects in a URL space this deployment is not the encoder for.
    //
    // Nothing else bounds the epoch: the source lives under `original/{id}/{version}/`
    // with no epoch in its key, so `v1-1`, `v1-2`, ... `v1-999999` would all find the
    // same source and each write a fresh derivative. That is an unbounded key space
    // reachable from a crafted URL — the amplification vector bucketing exists to
    // close — and it would also silently file bytes encoded under today's policy
    // under a past epoch's promise.
    //
    // A stale-epoch URL for a variant that *was* already generated still serves from
    // S3 and never reaches here, which is what makes this affordable.
    if (encoderEpoch !== this.config.delivery.encoderEpoch) {
      return this.clientError(
        404,
        'stale_encoder_epoch',
        `Encoder epoch ${encoderEpoch} is not current.`,
      );
    }

    const canonicalKey = toCanonicalKey({ assetId, assetVersion, encoderEpoch, spec });

    const startedAt = Date.now();

    try {
      const source = await this.loadSource(assetId, assetVersion);
      if (source === undefined) {
        return this.clientError(404, 'source_not_found', `No source for asset "${assetId}".`);
      }

      const result = await renderWithTimeout(
        source.bytes,
        spec,
        this.config.processing.generationTimeoutMs,
        { maxPixels: this.config.upload.maxPixels },
      );

      // Written only here, only once, and only from a fully rendered buffer — there
      // is no code path that streams partial output to the key. A conditional write
      // makes concurrent generators harmless: the loser discards its copy, and since
      // rendering is deterministic it was about to write identical bytes anyway.
      const written = await this.storage.putIfAbsent(canonicalKey, result.data, {
        contentType: FORMAT_MIME_TYPES[spec.format],
        cacheControl: IMMUTABLE_CACHE,
      });

      /*
       * `redundant` is the whole point of this call.
       *
       * A conditional write that loses means the object was already there — so this
       * request regenerated something that existed. Once, that is a harmless race
       * between two concurrent first-requests. Sustained, it is the signature of
       * edge/core normalization drift, which produces no errors and no 5xx and is
       * otherwise completely invisible. See design.md D4.
       */
      recordGeneration({
        format: spec.format,
        ...(spec.width !== undefined ? { width: spec.width } : {}),
        durationMs: Date.now() - startedAt,
        bytes: result.bytes,
        source: 'ondemand',
        redundant: !written.written,
        assetId,
        canonicalKey,
      });

      await this.recordDerivative(canonicalKey, assetId, assetVersion, spec, result);

      this.logger.info(
        {
          assetId,
          key: canonicalKey,
          sourceKey: source.key,
          fromMaster: source.fromMaster,
          bytes: result.bytes,
          raced: !written.written,
        },
        'derivative generated on demand',
      );

      return {
        status: 200,
        headers: this.deliveryHeaders(spec.format, written.etag),
        body: result.data,
      };
    } catch (error) {
      const classified = error instanceof ProcessingError ? error : classifyError(error);

      recordGenerationFailure(classified.code, { assetId, key: canonicalKey });
      this.logger.error(
        { err: error, key: canonicalKey, code: classified.code },
        'generation failed',
      );

      // 502 with no-store: a failure must never be cached, or one bad moment pins a
      // broken image behind a year-long TTL.
      return {
        status: 502,
        headers: { 'cache-control': NO_STORE, 'content-type': 'application/json' },
        error: { code: classified.code, message: 'Failed to generate derivative.' },
      };
    }
  }

  /**
   * Picks the decode source, preferring a master rendition when one exists.
   *
   * The master is a bounded intermediate materialized for very large originals, so
   * for those this converts every miss from "decode the full original" to "decode a
   * 4000px WebP" — roughly an order of magnitude less work. See design.md D7.
   *
   * The original's extension depends on what was uploaded and is not recoverable
   * from the delivery path, hence the prefix listing. Both lookups are issued
   * together: the master usually does not exist, and paying two round trips to
   * discover that would cost more than the wasted list.
   */
  private async loadSource(
    assetId: string,
    assetVersion: number,
  ): Promise<{ bytes: Buffer; key: string; fromMaster: boolean } | undefined> {
    const masterKey = toMasterKey(assetId, assetVersion);

    const [master, originals] = await Promise.all([
      this.storage.head(masterKey),
      this.storage.list(toOriginalPrefix(assetId, assetVersion), { maxKeys: 1 }),
    ]);

    if (master !== undefined) {
      return { bytes: await this.storage.get(masterKey), key: masterKey, fromMaster: true };
    }

    const original = originals.objects[0];
    if (original === undefined) return undefined;

    return { bytes: await this.storage.get(original.key), key: original.key, fromMaster: false };
  }

  /**
   * Headers a stored object would carry.
   *
   * `Vary: Accept` goes on every response rather than only negotiated ones. The
   * format is already concrete in the key, so this function cannot tell whether it
   * arrived via `format=auto` — and neither can S3 when it serves the same object
   * later. Emitting it unconditionally is what keeps the two identical, and it costs
   * nothing: CloudFront's cache key comes from the cache policy, not from `Vary`.
   */
  private deliveryHeaders(format: OutputFormat, etag: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': FORMAT_MIME_TYPES[format],
      'cache-control': IMMUTABLE_CACHE,
      vary: 'Accept',
    };
    if (etag !== '') headers['etag'] = `"${etag}"`;
    return headers;
  }

  private clientError(status: number, code: string, message: string): GeneratorResponse {
    return {
      status,
      headers: { 'cache-control': ERROR_CACHE, 'content-type': 'application/json' },
      error: { code, message },
    };
  }

  /** Bookkeeping only. The delivery path never reads this, so it never blocks. */
  private async recordDerivative(
    canonicalKey: string,
    assetId: string,
    version: number,
    spec: TransformSpec,
    result: { width: number; height: number; bytes: number },
  ): Promise<void> {
    if (this.record === undefined) return;

    try {
      await this.record({
        canonicalKey,
        assetId,
        version,
        format: spec.format,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
      });
    } catch (error) {
      this.logger.warn({ err: error, key: canonicalKey }, 'derivative bookkeeping failed');
    }
  }
}
