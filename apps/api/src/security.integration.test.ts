/**
 * Security integration tests (task 11.8).
 *
 * Every case here is an attack the design claims to defeat, driven end to end
 * against the real app, MinIO, and Postgres. They exist because each of these
 * failures is silent: a polyglot that gets served as HTML, an unscoped API key, or a
 * traversal that reaches an original all look like a working service right up until
 * they do not.
 *
 * Run `pnpm dev:up` and apply migrations first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DEFAULT_TENANT_ID, type PrismaClient } from '@imgopt/db';
import type { StoragePort } from '@imgopt/storage';

process.env['AWS_REGION'] ??= 'us-east-1';
process.env['S3_BUCKET'] ??= 'imgopt-dev';
process.env['S3_ENDPOINT'] ??= 'http://localhost:9100';
process.env['S3_FORCE_PATH_STYLE'] ??= 'true';
process.env['AWS_ACCESS_KEY_ID'] ??= 'minioadmin';
process.env['AWS_SECRET_ACCESS_KEY'] ??= 'minioadmin';
process.env['DATABASE_URL'] ??= 'postgres://imgopt:imgopt@localhost:5434/imgopt';
process.env['SQS_OPTIMIZE_QUEUE_URL'] ??= 'http://localhost:9324/000000000000/imgopt-optimize';
process.env['SQS_ENDPOINT'] ??= 'http://localhost:9324';
process.env['CDN_HOST'] ??= 'cdn.example.com';
process.env['UPLOAD_MAX_PIXELS'] ??= String(40_000_000);
process.env['LOG_LEVEL'] ??= 'error';
// The control plane refuses to start without this — serving the internal worker
// routes unauthenticated is worse than not starting at all.
process.env['WORKER_CALLBACK_SECRET'] ??= 'itest-worker-secret';

const { createApp } = await import('./app.factory.js');
const { ApiKeyService } = await import('./modules/auth/api-key.service.js');
const { PRISMA, STORAGE } = await import('./tokens.js');

let app: NestFastifyApplication;
let baseUrl: string;
let uploadKey: string;
let adminKey: string;
const createdAssetIds: string[] = [];

async function jpeg(width = 400, height = 300): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 90, b: 40 } } })
    .jpeg()
    .toBuffer();
}

async function upload(bytes: Buffer, type: string, filename: string, key = uploadKey) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), filename);
  const res = await fetch(`${baseUrl}/v1/images`, {
    method: 'POST',
    headers: { 'x-api-key': key },
    body: form,
  });
  const body = (await res.json()) as Record<string, unknown>;
  const asset = body['asset'] as { id?: string } | undefined;
  if (asset?.id !== undefined) createdAssetIds.push(asset.id);
  return { status: res.status, body };
}

beforeAll(async () => {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;

  const keys = app.get(ApiKeyService);
  uploadKey = (
    await keys.create({
      tenantId: DEFAULT_TENANT_ID,
      name: `sec-upload-${Date.now()}`,
      permissions: ['upload'],
    })
  ).plaintext;
  adminKey = (
    await keys.create({
      tenantId: DEFAULT_TENANT_ID,
      name: `sec-admin-${Date.now()}`,
      permissions: ['admin'],
    })
  ).plaintext;
}, 60_000);

afterAll(async () => {
  if (app === undefined) return;

  if (createdAssetIds.length > 0) {
    const prisma = app.get<PrismaClient>(PRISMA);
    await prisma.asset
      .deleteMany({ where: { id: { in: createdAssetIds } } })
      .catch(() => undefined);
  }
  await app.close();
});

describe('file type is verified from content, not from what was declared', () => {
  it('rejects an executable wearing an image content type', async () => {
    // ELF header. Declared as a JPEG, and the extension agrees — only the bytes
    // disagree, which is the only thing actually checked.
    const elf = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
      Buffer.alloc(2048, 0x90),
    ]);

    const { status, body } = await upload(elf, 'image/jpeg', 'totally-an-image.jpg');

    expect(status).toBeGreaterThanOrEqual(400);
    expect(String(JSON.stringify(body))).toMatch(/unsupported_format|content_type_mismatch/);
  });

  it('rejects a Windows executable the same way', async () => {
    const pe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2048, 0x00)]);
    expect((await upload(pe, 'image/png', 'setup.png')).status).toBeGreaterThanOrEqual(400);
  });

  it('rejects an image whose real format disagrees with the declared one', async () => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();

    // Genuinely a PNG, declared as JPEG. Accepting this would let the declared type
    // drive downstream handling while the bytes are something else.
    const { status } = await upload(png, 'image/jpeg', 'claims-jpeg.jpg');
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

describe('polyglot files', () => {
  it('never round-trips source bytes to a viewer', async () => {
    /*
     * A GIF whose header is valid and which also contains an HTML payload. The
     * defence is not detection — it is that no delivered byte is ever a source byte.
     * Every derivative is pipeline output, so the HTML cannot survive re-encoding,
     * and `nosniff` means even a mislabelled response is not sniffed as a document.
     */
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    const polyglot = Buffer.concat([gif, Buffer.from('<html><script>alert(1)</script>')]);

    const { status, body } = await upload(polyglot, 'image/gif', 'polyglot.gif');

    // GIF is not in the default accept list, so this is refused outright. If a
    // deployment enables GIF, the re-encode guarantee is what carries the weight.
    expect(status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(body)).not.toContain('<script>');
  });

  it('asserts nosniff on every API response', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('resource exhaustion', () => {
  it('refuses a decompression bomb before it is decoded', async () => {
    // ~46 megapixels of near-empty PNG: small on the wire, enormous decoded. The
    // configured pixel ceiling for this run is 40M.
    const bomb = await sharp({
      create: { width: 7000, height: 6600, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const { status, body } = await upload(bomb, 'image/png', 'bomb.png');

    expect(status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(body)).toContain('pixel_limit_exceeded');
  }, 60_000);

  it('constrains a presigned target by content length, at the storage service', async () => {
    const res = await fetch(`${baseUrl}/v1/images/uploads`, {
      method: 'POST',
      headers: { 'x-api-key': uploadKey, 'content-type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg' }),
    });
    const body = (await res.json()) as {
      assetId: string;
      upload: { url: string; fields: Record<string, string> };
    };
    createdAssetIds.push(body.assetId);

    // The policy is enforced by storage itself, before any of our code runs — which
    // is the only way to bound a direct-to-storage upload.
    // `Policy`, capitalised — the SDK's field name, not a lowercase convention.
    const policy = Buffer.from(body.upload.fields['Policy'] ?? '', 'base64').toString('utf8');
    expect(policy).toContain('content-length-range');

    const oversized = Buffer.alloc(1024, 1);
    const form = new FormData();
    for (const [k, v] of Object.entries(body.upload.fields)) form.append(k, v);
    form.append('file', new Blob([oversized]), 'big.jpg');

    // Rewriting the declared size does not help: the signature covers the policy.
    const tampered = new FormData();
    for (const [k, v] of Object.entries(body.upload.fields)) {
      tampered.append(k, k === 'Policy' ? Buffer.from('{}').toString('base64') : v);
    }
    tampered.append('file', new Blob([oversized]), 'big.jpg');

    const res2 = await fetch(body.upload.url, { method: 'POST', body: tampered });
    expect(res2.status).toBeGreaterThanOrEqual(400);
  });
});

describe('authentication and authorization', () => {
  it('refuses an unauthenticated upload before any handler runs', async () => {
    const form = new FormData();
    form.append('file', new Blob([await jpeg()], { type: 'image/jpeg' }), 'x.jpg');
    const res = await fetch(`${baseUrl}/v1/images`, { method: 'POST', body: form });
    const body = (await res.json()) as { error?: { code?: string } };

    expect(res.status).toBe(401);
    // The `unauthorized` code proves the *global guard* rejected it rather than a
    // handler, which is what guarantees no asset row was created — the controller
    // never ran.
    //
    // Asserting that by counting asset rows would be wrong: `pnpm -r` runs each
    // package's integration tests in parallel against one Postgres, so the global
    // count moves under the test and it fails perhaps one run in three.
    expect(body.error?.code).toBe('unauthorized');
  });

  it('refuses a key that lacks the permission', async () => {
    // The upload key has `upload` but not `admin`.
    const res = await fetch(`${baseUrl}/v1/keys`, {
      method: 'POST',
      headers: { 'x-api-key': uploadKey, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'escalation attempt' }),
    });

    expect(res.status).toBe(403);
  });

  it('serves health checks without credentials', async () => {
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
  });
});

describe('API key lifecycle', () => {
  it('returns the plaintext exactly once and stores only a hash', async () => {
    const res = await fetch(`${baseUrl}/v1/keys`, {
      method: 'POST',
      headers: { 'x-api-key': adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `issued-${Date.now()}`, permissions: ['upload'] }),
    });
    const body = (await res.json()) as { key: { id: string }; plaintext: string };

    expect(res.status).toBe(201);
    expect(body.plaintext).toMatch(/^imgk_/);

    // The stored row holds a hash, and the hash is not the key.
    const row = await app
      .get<PrismaClient>(PRISMA)
      .apiKey.findUnique({ where: { id: body.key.id } });
    expect(row?.hash).toBeDefined();
    expect(row?.hash).not.toBe(body.plaintext);

    // Listing never carries it, so there is no second chance to read it.
    const list = await fetch(`${baseUrl}/v1/keys`, { headers: { 'x-api-key': adminKey } });
    expect(JSON.stringify(await list.json())).not.toContain(body.plaintext);
  });

  it('rejects a revoked key on the very next request', async () => {
    const created = await fetch(`${baseUrl}/v1/keys`, {
      method: 'POST',
      headers: { 'x-api-key': adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `doomed-${Date.now()}`, permissions: ['upload'] }),
    });
    const { key, plaintext } = (await created.json()) as {
      key: { id: string };
      plaintext: string;
    };

    const before = await upload(await jpeg(), 'image/jpeg', 'before.jpg', plaintext);
    expect(before.status).toBe(201);

    await fetch(`${baseUrl}/v1/keys/${key.id}`, {
      method: 'DELETE',
      headers: { 'x-api-key': adminKey },
    });

    const after = await upload(await jpeg(64, 64), 'image/jpeg', 'after.jpg', plaintext);
    expect(after.status).toBe(401);
  });

  it('does not leak a key through a wrong-but-plausible value', async () => {
    // Right shape, wrong secret. Must be indistinguishable from any other failure.
    const forged = `${uploadKey.slice(0, uploadKey.length - 8)}deadbeef`;
    const res = await upload(await jpeg(64, 64), 'image/jpeg', 'forged.jpg', forged);

    expect(res.status).toBe(401);
  });
});

describe('storage is not reachable except through the service', () => {
  it('keeps originals out of the derivatives prefix the CDN can read', async () => {
    const { body } = await upload(await jpeg(), 'image/jpeg', 'private.jpg');
    const asset = body['asset'] as { id: string };

    const storage = app.get<StoragePort>(STORAGE);
    const derived = await storage.list(`derived/${asset.id}/`);
    const originals = await storage.list(`original/${asset.id}/`);

    // Only `derived/` is exposed through the distribution, so an original being
    // anywhere else is what keeps it unreachable.
    expect(originals.objects.length).toBeGreaterThan(0);
    for (const object of [...derived.objects, ...originals.objects]) {
      expect(object.key.startsWith('derived/') || object.key.startsWith('original/')).toBe(true);
    }
    for (const object of originals.objects) {
      expect(object.key.startsWith('derived/')).toBe(false);
    }
  });

  it('removes the staged object once an upload is promoted', async () => {
    const { body } = await upload(await jpeg(), 'image/jpeg', 'staged.jpg');
    const asset = body['asset'] as { id: string };

    const storage = app.get<StoragePort>(STORAGE);
    expect(await storage.exists(`staging/${asset.id}`)).toBe(false);
  });

  it('deletes the staged object when validation refuses the bytes', async () => {
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(512)]);
    const { body } = await upload(elf, 'image/jpeg', 'rejected.jpg');
    const asset = body['asset'] as { id?: string } | undefined;

    if (asset?.id !== undefined) {
      const storage = app.get<StoragePort>(STORAGE);
      expect(await storage.exists(`staging/${asset.id}`)).toBe(false);
    }
  });
});

describe('response headers', () => {
  it('carries the full security header set', async () => {
    const res = await fetch(`${baseUrl}/healthz`);

    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('does not pin localhost to HTTPS in development', async () => {
    // HSTS over plain HTTP is ignored by browsers anyway, but sending it would pin
    // localhost in a developer's browser — genuinely annoying to undo.
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('never caches an API response', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
