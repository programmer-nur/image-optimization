/**
 * Generator unit tests — the branches that reject before any I/O.
 *
 * The storage double throws on every call, so these assert something stronger than
 * the status code: that a request which cannot possibly be legitimate is turned away
 * without a single S3 round trip. That is what keeps a flood of crafted URLs from
 * becoming a flood of origin requests.
 *
 * Everything that actually renders lives in `generator.integration.test.ts`, against
 * real storage.
 */

import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@imgopt/config';
import type { StoragePort } from '@imgopt/storage';
import { Generator } from './generator.js';

const explodingStorage = new Proxy({} as StoragePort, {
  get(_target, property) {
    return () => {
      throw new Error(`storage.${String(property)} must not be called on a rejected request`);
    };
  },
});

const config = {
  delivery: { encoderEpoch: 4 },
  processing: { generationTimeoutMs: 1000 },
  upload: { maxPixels: 1_000_000 },
} as AppConfig;

const noopLogger = { info() {}, warn() {}, error() {} };
const generator = new Generator(explodingStorage, config, noopLogger);

describe('paths that are not canonical derivative keys', () => {
  it.each([
    ['/i/abc/v4-4/photo.jpg?w=640', 'a delivery URL the edge never normalized'],
    ['/original/abc/1/source.jpg', 'the originals prefix'],
    ['/master/abc/1/master.webp', 'the masters prefix'],
    ['/derived/abc/v4-4/w640_q75.gif', 'an unsupported extension'],
    // The bound the cost model rests on, tested where the object would be minted:
    // the id, version, and epoch are visible in every public URL, so a sweep of
    // `w641, w642, …` is a sweep of Sharp invocations and permanent objects.
    ['/derived/abc/v4-4/w641_q75.avif', 'a width off the ladder'],
    ['/derived/abc/v4-4/w12_q75.avif', 'a width below the smallest rung'],
    ['/derived/abc/v4-4/w640_h361_cover_q75.avif', 'a height the ratio quantizer cannot produce'],
    ['/derived/abc/v4-4/w640_h360_contain_q75_bg010203.avif', 'a background off the channel grid'],
    ['/derived/abc/v4-4/w640_q70.avif', 'a quality off the level set'],
    ['/derived/abc/v4-4/w640_q75_bl0.avif', 'an inert effect that would fragment the cache'],
    ['/derived/abc/v4-4/q75_w640.avif', 'tokens out of canonical order'],
    ['/derived/abc/v4/w640_q75.avif', 'a version segment with no epoch'],
    ['/healthz', 'not a derivative path at all'],
  ])('rejects %s (%s) with a short-lived 400', async (path) => {
    const response = await generator.generate(path);

    expect(response.status).toBe(400);
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    expect(response.body).toBeUndefined();
  });
});

describe('encoder epoch', () => {
  it('accepts only the configured epoch', async () => {
    // Nothing in the source key mentions the epoch, so every value would resolve to
    // the same original and write a distinct object. Unbounded, and reachable from a
    // crafted URL.
    for (const epoch of [0, 1, 3, 5, 999]) {
      const response = await generator.generate(`/derived/abc/v1-${epoch}/w640_q75.avif`);
      expect(response.status, `epoch ${epoch} should not generate`).toBe(404);
    }
  });

  it('passes the configured epoch through to storage', async () => {
    // Reaching storage is the pass condition here: the exploding double turns "got
    // past the guards" into a distinctive failure rather than a silent 404.
    await expect(generator.generate('/derived/abc/v1-4/w640_q75.avif')).resolves.toMatchObject({
      status: 502,
    });
  });
});
