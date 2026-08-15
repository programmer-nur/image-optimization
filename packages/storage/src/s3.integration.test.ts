/**
 * Integration tests against MinIO.
 *
 * Run `pnpm dev:up` first. These exercise the real S3 wire protocol rather than a
 * mock, which is the only way to catch the behaviours that actually bite: how a
 * missing key is reported, whether a conditional write really is atomic, and whether
 * a presigned policy is enforced by the service rather than by us.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectNotFoundError, StorageError } from './port.js';
import { S3Storage } from './s3.js';

const ENDPOINT = process.env['S3_ENDPOINT'] ?? 'http://localhost:9100';
const BUCKET = process.env['S3_BUCKET'] ?? 'imgopt-dev';

const storage = new S3Storage({
  bucket: BUCKET,
  region: 'us-east-1',
  endpoint: ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
});

/** Unique per run so parallel runs and leftovers cannot collide. */
const RUN = `itest/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const key = (name: string): string => `${RUN}/${name}`;

beforeAll(async () => {
  // Fail loudly rather than mysteriously if the stack is not running.
  await storage.list(RUN).catch((error: unknown) => {
    throw new Error(
      `Cannot reach object storage at ${ENDPOINT}. Run "pnpm dev:up" first. (${String(error)})`,
    );
  });
});

afterAll(async () => {
  await storage.deletePrefix(RUN);
  storage.destroy();
});

describe('put and get', () => {
  it('round-trips bytes', async () => {
    const k = key('roundtrip.bin');
    const body = Buffer.from('hello storage');

    const put = await storage.put(k, body, { contentType: 'application/octet-stream' });
    expect(put.etag).not.toBe('');

    const got = await storage.get(k);
    expect(got.equals(body)).toBe(true);
  });

  it('preserves content type and cache control', async () => {
    const k = key('headers.webp');
    await storage.put(k, Buffer.from('x'), {
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    });

    const head = await storage.head(k);
    expect(head?.contentType).toBe('image/webp');
    expect(head?.cacheControl).toBe('public, max-age=31536000, immutable');
  });

  it('stores custom metadata', async () => {
    const k = key('meta.bin');
    await storage.put(k, Buffer.from('x'), { metadata: { assetid: 'abc123', version: '3' } });

    const head = await storage.head(k);
    expect(head?.metadata['assetid']).toBe('abc123');
  });

  it('reads a byte range without fetching the whole object', async () => {
    const k = key('ranged.bin');
    await storage.put(k, Buffer.from('0123456789'));

    // How upload validation sniffs magic bytes without pulling a 100MB file.
    expect((await storage.getRange(k, 0, 3)).toString()).toBe('0123');
  });

  it('streams an object', async () => {
    const k = key('stream.bin');
    await storage.put(k, Buffer.from('streamed content'));

    const stream = await storage.getStream(k);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));

    expect(Buffer.concat(chunks).toString()).toBe('streamed content');
  });
});

describe('missing keys', () => {
  it('returns undefined from head rather than throwing', async () => {
    expect(await storage.head(key('does-not-exist'))).toBeUndefined();
  });

  it('reports exists as false', async () => {
    expect(await storage.exists(key('does-not-exist'))).toBe(false);
  });

  it('throws a typed error from get', async () => {
    await expect(storage.get(key('does-not-exist'))).rejects.toBeInstanceOf(ObjectNotFoundError);
  });
});

describe('conditional writes', () => {
  it('writes when the key is absent', async () => {
    const result = await storage.putIfAbsent(key('cond-new.bin'), Buffer.from('first'));
    expect(result.written).toBe(true);
  });

  it('declines to overwrite an existing key', async () => {
    const k = key('cond-existing.bin');
    await storage.putIfAbsent(k, Buffer.from('first'));

    const second = await storage.putIfAbsent(k, Buffer.from('second'));
    expect(second.written).toBe(false);

    // The original bytes must survive: this is what makes a generation race safe.
    expect((await storage.get(k)).toString()).toBe('first');
  });

  it('lets exactly one writer win a concurrent race', async () => {
    const k = key('cond-race.bin');

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => storage.putIfAbsent(k, Buffer.from(`writer-${i}`))),
    );

    expect(results.filter((r) => r.written)).toHaveLength(1);
    expect(await storage.exists(k)).toBe(true);
  });
});

describe('copy', () => {
  it('promotes an object server-side', async () => {
    const from = key('staging-object.bin');
    const to = key('promoted-object.bin');
    await storage.put(from, Buffer.from('original bytes'));

    await storage.copy(from, to);

    expect((await storage.get(to)).toString()).toBe('original bytes');
    // The source survives; promotion is a copy, and cleanup is a separate step.
    expect(await storage.exists(from)).toBe(true);
  });

  it('throws when the source is missing', async () => {
    await expect(storage.copy(key('nope'), key('dest'))).rejects.toBeInstanceOf(StorageError);
  });
});

describe('listing and prefix deletion', () => {
  it('lists by prefix', async () => {
    const prefix = key('listing');
    await Promise.all([
      storage.put(`${prefix}/a.bin`, Buffer.from('a')),
      storage.put(`${prefix}/b.bin`, Buffer.from('b')),
      storage.put(`${prefix}/c.bin`, Buffer.from('c')),
    ]);

    const result = await storage.list(prefix);
    expect(result.objects).toHaveLength(3);
    expect(result.objects.map((o) => o.key).sort()).toEqual([
      `${prefix}/a.bin`,
      `${prefix}/b.bin`,
      `${prefix}/c.bin`,
    ]);
  });

  it('paginates', async () => {
    const prefix = key('paged');
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => storage.put(`${prefix}/${i}.bin`, Buffer.from('x'))),
    );

    const first = await storage.list(prefix, { maxKeys: 2 });
    expect(first.objects).toHaveLength(2);
    expect(first.continuationToken).toBeDefined();

    const second = await storage.list(prefix, {
      maxKeys: 2,
      continuationToken: first.continuationToken!,
    });
    expect(second.objects).toHaveLength(2);
    expect(second.objects[0]!.key).not.toBe(first.objects[0]!.key);
  });

  it('deletes an entire prefix, as version-scoped cleanup requires', async () => {
    const prefix = key('bulk');
    await Promise.all(
      Array.from({ length: 7 }, (_, i) => storage.put(`${prefix}/${i}.bin`, Buffer.from('x'))),
    );

    expect(await storage.deletePrefix(prefix)).toBe(7);
    expect((await storage.list(prefix)).objects).toHaveLength(0);
  });

  it('returns zero for an empty prefix', async () => {
    expect(await storage.deletePrefix(key('nothing-here'))).toBe(0);
  });
});

describe('delete', () => {
  it('removes an object', async () => {
    const k = key('deleteme.bin');
    await storage.put(k, Buffer.from('x'));

    await storage.delete(k);
    expect(await storage.exists(k)).toBe(false);
  });

  it('is idempotent', async () => {
    await expect(storage.delete(key('never-existed'))).resolves.toBeUndefined();
  });
});

describe('presigned upload', () => {
  it('produces a usable target', async () => {
    const target = await storage.presignUpload(key('presigned.jpg'), {
      minBytes: 1,
      maxBytes: 1024 * 1024,
      contentType: 'image/jpeg',
      expiresInSeconds: 300,
    });

    expect(target.url).toContain(ENDPOINT.replace(/^https?:\/\//, ''));
    expect(target.fields['key']).toBeDefined();
    expect(target.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('accepts an upload inside the declared size range', async () => {
    const k = key('presigned-ok.jpg');
    const target = await storage.presignUpload(k, {
      minBytes: 1,
      maxBytes: 1024,
      contentType: 'image/jpeg',
      expiresInSeconds: 300,
    });

    const form = new FormData();
    for (const [name, value] of Object.entries(target.fields)) form.append(name, value);
    form.append('file', new Blob([Buffer.from('small file')], { type: 'image/jpeg' }));

    const response = await fetch(target.url, { method: 'POST', body: form });
    expect(response.status).toBeLessThan(300);
    expect(await storage.exists(k)).toBe(true);
  });

  it('lets storage reject an oversized upload before it reaches us', async () => {
    const k = key('presigned-toobig.jpg');
    const target = await storage.presignUpload(k, {
      minBytes: 1,
      maxBytes: 10,
      contentType: 'image/jpeg',
      expiresInSeconds: 300,
    });

    const form = new FormData();
    for (const [name, value] of Object.entries(target.fields)) form.append(name, value);
    form.append('file', new Blob([Buffer.alloc(5000)], { type: 'image/jpeg' }));

    const response = await fetch(target.url, { method: 'POST', body: form });

    // The point of the content-length-range condition: an oversized upload never
    // becomes our quota, our bandwidth, or our problem.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await storage.exists(k)).toBe(false);
  });
});

describe('multipart upload', () => {
  it('creates part URLs and completes', async () => {
    const k = key('multipart.bin');
    const upload = await storage.createMultipartUpload(k, 2, {
      contentType: 'application/octet-stream',
      expiresInSeconds: 300,
    });

    expect(upload.partUrls).toHaveLength(2);

    // S3 requires every part except the last to be at least 5MB.
    const partBody = Buffer.alloc(5 * 1024 * 1024, 'a');
    const lastBody = Buffer.from('tail');

    const etags: Array<{ partNumber: number; etag: string }> = [];
    for (const [index, body] of [partBody, lastBody].entries()) {
      const response = await fetch(upload.partUrls[index]!, { method: 'PUT', body });
      expect(response.status).toBe(200);
      etags.push({ partNumber: index + 1, etag: response.headers.get('etag') ?? '' });
    }

    await storage.completeMultipartUpload(k, upload.uploadId, etags);

    const head = await storage.head(k);
    expect(head?.bytes).toBe(partBody.length + lastBody.length);
  });

  it('aborts cleanly', async () => {
    const k = key('multipart-abort.bin');
    const upload = await storage.createMultipartUpload(k, 1, {
      contentType: 'application/octet-stream',
      expiresInSeconds: 300,
    });

    await expect(storage.abortMultipartUpload(k, upload.uploadId)).resolves.toBeUndefined();
    expect(await storage.exists(k)).toBe(false);
  });
});
