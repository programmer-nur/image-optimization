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

/**
 * Largest derivative this function can hand back in its own response.
 *
 * A Lambda Function URL caps the response payload at 6MB, and binary bodies travel
 * base64-encoded — 4/3 the bytes — so the real ceiling on image data is about 4.5MB.
 * Past it the invocation fails outright, and the viewer who happened to be first for
 * that variant gets an error for an object that is, by then, sitting in S3 perfectly
 * intact. Rare (an AVIF or WebP derivative that large is close to pathological) but
 * not impossible: PNG at 3840px wide with photographic content clears it easily.
 *
 * A margin is left for headers and the JSON envelope.
 */
export const MAX_INLINE_BYTES = Math.floor((6 * 1024 * 1024 * 3) / 4) - 64 * 1024;

/**
 * Lifetime of the oversize redirect target.
 *
 * Long enough for a viewer to follow a redirect, short enough that the URL is not
 * worth passing around. Every later request for this variant is an ordinary S3 hit
 * through CloudFront and never sees a presigned URL at all.
 */
export const OVERSIZE_REDIRECT_TTL_SECONDS = 300;

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

      /*
       * Too large to travel inside the response — point the viewer at the object.
       *
       * The bytes are already written to this exact key, so nothing is regenerated;
       * only the delivery of this one first request changes. The target is a
       * short-lived presigned URL rather than the delivery URL the viewer came from:
       * the generator is handed the rewritten path and never sees the viewer's own
       * URL, and a redirect back into `/derived/...` is refused at the edge by design.
       *
       * `no-store`, always. A cached redirect would shadow the object it points at
       * for a year, and the presigned URL inside it expires in minutes.
       *
       * Without this the viewer who happens to be first for an oversized variant gets
       * a failed invocation for an object sitting intact in storage. It self-heals on
       * the next request either way — this makes the first one work too.
       */
      if (result.data.byteLength > MAX_INLINE_BYTES) {
        const redirect = await this.redirectToStoredObject(canonicalKey, result.bytes);
        if (redirect !== undefined) return redirect;
      }

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

  /**
   * Builds the oversize redirect, or gives up and lets the caller return the bytes.
   *
   * Returning the (too large) body is not a working response, but it is the same
   * failure that existed before this path, and it is strictly better than turning a
   * presign outage into a second failure mode nobody has seen. The signing itself is
   * local — no network call — so this failing at all means something structural.
   */
  private async redirectToStoredObject(
    canonicalKey: string,
    bytes: number,
  ): Promise<GeneratorResponse | undefined> {
    try {
      const location = await this.storage.presignDownload(canonicalKey, {
        expiresInSeconds: OVERSIZE_REDIRECT_TTL_SECONDS,
      });

      this.logger.warn(
        { key: canonicalKey, bytes },
        'derivative exceeds the inline response limit; redirecting to the stored object',
      );

      return {
        status: 307,
        headers: {
          location,
          'cache-control': NO_STORE,
          'content-type': 'application/json',
        },
        error: { code: 'derivative_too_large_to_inline', message: 'Served from storage.' },
      };
    } catch (error) {
      this.logger.error(
        { err: error, key: canonicalKey, bytes },
        'could not presign the oversized derivative; returning it inline may exceed the limit',
      );
      return undefined;
    }
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
