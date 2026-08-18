/**
 * Generator integration test.
 *
 * Runs the real generator against MinIO with real images. Needs `pnpm dev:up`; no
 * Postgres, because the delivery path never reads one and bookkeeping is stubbed.
 *
 * Test paths are never hand-written. They are built by running a query string
 * through `packages/core` — the same normalization the CloudFront Function is
 * generated from and pinned against by the conformance suite — so these tests
 * exercise the actual chain: edge normalizes a URL, the generator parses that path
 * back, and the object lands where CloudFront will look for it next time. A
 * hand-written path would test the generator against a fiction.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { loadConfig, type AppConfig } from '@imgopt/config';
import { S3Storage } from '@imgopt/storage';
import { parseTransformFromQuery, toCanonicalKey, toMasterKey } from '@imgopt/core';
import { Generator, IMMUTABLE_CACHE, type RecordDerivative } from './generator.js';

process.env['AWS_REGION'] ??= 'us-east-1';
process.env['S3_BUCKET'] ??= 'imgopt-dev';
process.env['S3_ENDPOINT'] ??= 'http://localhost:9100';
process.env['S3_FORCE_PATH_STYLE'] ??= 'true';
process.env['AWS_ACCESS_KEY_ID'] ??= 'minioadmin';
process.env['AWS_SECRET_ACCESS_KEY'] ??= 'minioadmin';
process.env['DATABASE_URL'] ??= 'postgres://imgopt:imgopt@localhost:5434/imgopt';
process.env['SQS_OPTIMIZE_QUEUE_URL'] ??= 'http://localhost:9324/000000000000/imgopt-optimize';
process.env['CDN_HOST'] ??= 'cdn.example.com';
process.env['ENCODER_EPOCH'] ??= '1';
process.env['LOG_LEVEL'] ??= 'silent';

const config: AppConfig = loadConfig();
const EPOCH = config.delivery.encoderEpoch;

const storage = new S3Storage({
  bucket: config.storage.bucket,
  region: config.storage.region,
  endpoint: config.storage.endpoint!,
  forcePathStyle: true,
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
});

const noopLogger = { info() {}, warn() {}, error() {} };

const recorded: Array<{ canonicalKey: string; width: number }> = [];
const recorder: RecordDerivative = (record) => {
  recorded.push({ canonicalKey: record.canonicalKey, width: record.width });
  return Promise.resolve();
};

const generator = new Generator(storage, config, noopLogger, recorder);

const createdIds: string[] = [];
const ACCEPT_AVIF = 'image/avif,image/webp,*/*';

function newId(): string {
  const id = `gen${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  createdIds.push(id);
  return id;
}

/** The exact path the edge function would rewrite this query to. */
function deliveryPath(assetId: string, query: string, version = 1, epoch = EPOCH): string {
  const parsed = parseTransformFromQuery(query, ACCEPT_AVIF);
  if (!parsed.ok) throw new Error(`fixture query rejected: ${parsed.error.message}`);

  return `/${toCanonicalKey({
    assetId,
    assetVersion: version,
    encoderEpoch: epoch,
    spec: parsed.spec,
  })}`;
}

async function photo(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 140, b: 60 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** Puts an original in storage. No database row: the generator never looks for one. */
async function storeOriginal(bytes: Buffer, ext = 'jpg'): Promise<string> {
  const id = newId();
  await storage.put(`original/${id}/1/source.${ext}`, bytes, { contentType: 'image/jpeg' });
  return id;
}

beforeAll(async () => {
  await storage.list('original/', { maxKeys: 1 }).catch((error: unknown) => {
    throw new Error(`Cannot reach MinIO. Run "pnpm dev:up". (${String(error)})`);
  });
});

afterAll(async () => {
  for (const id of createdIds) {
    await storage.deletePrefix(`original/${id}/`).catch(() => undefined);
    await storage.deletePrefix(`derived/${id}/`).catch(() => undefined);
    await storage.deletePrefix(`master/${id}/`).catch(() => undefined);
  }
  storage.destroy();
});

describe('first request for an uncached variant', () => {
  it('returns 200 with correctly rendered bytes', async () => {
    const id = await storeOriginal(await photo(1600, 900));
    const path = deliveryPath(id, 'w=640');

    const response = await generator.generate(path);

    expect(response.status).toBe(200);
    expect(response.body).toBeInstanceOf(Buffer);

    const meta = await sharp(response.body).metadata();
    // sharp reports AVIF through its HEIF container.
    expect(meta.format).toBe('heif');
    expect(meta.width).toBe(640);
    // 16:9 preserved from the source, since only a width was constrained.
    expect(meta.height).toBe(360);
  });

  it('persists the derivative at the exact key it was asked for', async () => {
    const id = await storeOriginal(await photo(1600, 900));
    const path = deliveryPath(id, 'w=640&q=85');

    const response = await generator.generate(path);
    const stored = await storage.get(path.slice(1));

    // Byte-identical: the next viewer is served this object instead of invoking
    // the generator, and must receive exactly what the first viewer received.
    expect(stored.equals(response.body!)).toBe(true);
  });

  it('never upscales past the source, even when the key names a larger bucket', async () => {
    const id = await storeOriginal(await photo(500, 500));

    const response = await generator.generate(deliveryPath(id, 'w=1920'));

    // The key says w1920 because the edge has no source metadata; the pixels are
    // capped here. Both statements are true at once, by design (design.md D3).
    const meta = await sharp(response.body).metadata();
    expect(meta.width).toBe(500);
  });

  it('applies rare parameters recovered from the key', async () => {
    const id = await storeOriginal(await photo(1600, 900));
    // `pad` is a request-time spelling of `contain` — both reach sharp as the same
    // call, so both resolve to one key rather than two objects holding one image.
    const path = deliveryPath(id, 'w=640&h=640&fit=pad&background=ff0000');

    expect(path).toContain('w640_h640_contain_q75_bgff0000');

    const response = await generator.generate(path);
    const meta = await sharp(response.body).metadata();

    expect(response.status).toBe(200);
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(640);
  });
});

describe('second request', () => {
  it('finds the object in storage, so the generator is not consulted again', async () => {
    const id = await storeOriginal(await photo(1200, 800));
    const path = deliveryPath(id, 'w=480');

    expect(await storage.exists(path.slice(1))).toBe(false);
    await generator.generate(path);

    // This is the whole cost model: CloudFront asks S3 for this key, S3 now has it,
    // and the failover to the generator never fires again for this variant.
    expect(await storage.exists(path.slice(1))).toBe(true);
  });
});

describe('concurrent generation', () => {
  it('is harmless: one object, identical bytes to every caller', async () => {
    const id = await storeOriginal(await photo(1600, 900));
    const path = deliveryPath(id, 'w=828');

    const responses = await Promise.all(Array.from({ length: 6 }, () => generator.generate(path)));

    expect(responses.every((r) => r.status === 200)).toBe(true);

    // Deterministic rendering means the racers all produced the same bytes, so the
    // conditional write's loser discarding its copy costs nothing. No lock needed.
    const first = responses[0]!.body!;
    expect(responses.every((r) => r.body!.equals(first))).toBe(true);

    const listed = await storage.list(`derived/${id}/`);
    expect(listed.objects).toHaveLength(1);
    expect((await storage.get(path.slice(1))).equals(first)).toBe(true);
  });
});

describe('source selection', () => {
  it('prefers the master rendition when one exists', async () => {
    const id = await storeOriginal(await photo(1600, 900));

    // A master that is deliberately a different shape, so which source was decoded
    // is visible in the output rather than inferred.
    const masterKey = toMasterKey(id, 1);
    await storage.put(
      masterKey,
      await sharp({ create: { width: 800, height: 800, channels: 3, background: 'blue' } })
        .webp()
        .toBuffer(),
      { contentType: 'image/webp' },
    );

    const response = await generator.generate(deliveryPath(id, 'w=320'));
    const meta = await sharp(response.body).metadata();

    expect(meta.width).toBe(320);
    expect(meta.height).toBe(320);
  });

  it('falls back to the original when there is no master', async () => {
    const id = await storeOriginal(await photo(1600, 900));

    const response = await generator.generate(deliveryPath(id, 'w=320'));
    const meta = await sharp(response.body).metadata();

    expect(meta.height).toBe(180);
  });

  it('finds the original whatever extension it was uploaded with', async () => {
    const id = newId();
    await storage.put(
      `original/${id}/1/source.png`,
      await sharp({ create: { width: 400, height: 400, channels: 3, background: 'red' } })
        .png()
        .toBuffer(),
      { contentType: 'image/png' },
    );

    const response = await generator.generate(deliveryPath(id, 'w=320'));
    expect(response.status).toBe(200);
  });
});

describe('response headers', () => {
  it('match what the stored object will serve', async () => {
    const id = await storeOriginal(await photo(1600, 900));
    const path = deliveryPath(id, 'w=640');

    const response = await generator.generate(path);
    const head = await storage.head(path.slice(1));

    // The first viewer is served by Lambda and every later viewer by S3. If these
    // disagree, the first viewer caches on different terms than everyone else.
    expect(response.headers['cache-control']).toBe(IMMUTABLE_CACHE);
    expect(head!.cacheControl).toBe(IMMUTABLE_CACHE);
    expect(response.headers['content-type']).toBe('image/avif');
    expect(head!.contentType).toBe('image/avif');
    expect(response.headers['etag']).toBe(`"${head!.etag}"`);
    expect(response.headers['vary']).toBe('Accept');
  });

  it('carries the negotiated format for each extension', async () => {
    const id = await storeOriginal(await photo(800, 600));

    for (const [query, type] of [
      ['w=320&format=webp', 'image/webp'],
      ['w=320&format=jpeg', 'image/jpeg'],
      ['w=320&format=png', 'image/png'],
    ] as const) {
      const response = await generator.generate(deliveryPath(id, query));
      expect(response.headers['content-type']).toBe(type);
    }
  });
});

describe('failures', () => {
  it('rejects a path that is not a canonical derivative key', async () => {
    for (const path of [
      '/original/abc/1/source.jpg',
      '/derived/abc/v1-1/not-a-variant.avif',
      '/derived/abc/nope/w640_q75.avif',
      '/i/abc/v1-1/photo.jpg?w=640',
    ]) {
      const response = await generator.generate(path);

      expect(response.status).toBe(400);
      expect(response.headers['cache-control']).toBe('public, max-age=60');
    }
  });

  it('returns a short-lived 404 for an asset with no source', async () => {
    const response = await generator.generate(deliveryPath(newId(), 'w=640'));

    expect(response.status).toBe(404);
    // Short, so a later upload to the same id is picked up rather than being
    // shadowed by a year of negative caching.
    expect(response.headers['cache-control']).toBe('public, max-age=60');
  });

  it('refuses to mint objects under a stale encoder epoch', async () => {
    const id = await storeOriginal(await photo(800, 600));
    const path = deliveryPath(id, 'w=640', 1, EPOCH + 7);

    const response = await generator.generate(path);

    // Otherwise any epoch in the URL resolves to the same source and writes a new
    // object — an unbounded key space reachable from a crafted URL.
    expect(response.status).toBe(404);
    expect(await storage.exists(path.slice(1))).toBe(false);
  });

  it('returns a non-storable 502 on a corrupt source and writes no object', async () => {
    const id = newId();
    await storage.put(`original/${id}/1/source.jpg`, Buffer.from('this is not an image'), {
      contentType: 'image/jpeg',
    });
    const path = deliveryPath(id, 'w=640');

    const response = await generator.generate(path);

    expect(response.status).toBe(502);
    expect(response.headers['cache-control']).toBe('no-store');
    // A partial or failed render must never become a year-cached object.
    expect(await storage.exists(path.slice(1))).toBe(false);
  });

  it('serves the image even when bookkeeping fails', async () => {
    const id = await storeOriginal(await photo(800, 600));
    const failing = new Generator(storage, config, noopLogger, () =>
      Promise.reject(new Error('database unreachable')),
    );

    const response = await failing.generate(deliveryPath(id, 'w=640'));

    expect(response.status).toBe(200);
  });
});

describe('bookkeeping', () => {
  it('records what was generated, for cost attribution and orphan GC', async () => {
    const id = await storeOriginal(await photo(1600, 900));
    const path = deliveryPath(id, 'w=750');
    recorded.length = 0;

    await generator.generate(path);

    expect(recorded).toEqual([{ canonicalKey: path.slice(1), width: 750 }]);
  });
});
