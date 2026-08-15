/**
 * End-to-end integration test.
 *
 * Boots the real Fastify app against MinIO, Postgres, and ElasticMQ, and drives it
 * over HTTP. This is the payoff test for the control plane: it proves the whole
 * wiring — guard, multipart parsing, streaming to staging, magic-byte validation,
 * promotion, and lifecycle — works together, not just in isolation.
 *
 * Run `pnpm dev:up` and apply migrations first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
// Type-only: erased at runtime, so it does not trigger the env-sensitive module load.
import type { PrismaClient } from '@imgopt/db';

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
process.env['UPLOAD_PROXY_THRESHOLD_BYTES'] ??= String(5 * 1024 * 1024);
process.env['LOG_LEVEL'] ??= 'error';

const { createApp } = await import('./app.factory.js');
const { ApiKeyService } = await import('./modules/auth/api-key.service.js');
const { PRISMA } = await import('./tokens.js');

let app: NestFastifyApplication;
let baseUrl: string;
let apiKey: string;
const createdAssetIds: string[] = [];

async function jpeg(width = 800, height = 600): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function uploadProxied(bytes: Buffer, type = 'image/jpeg', filename = 'test.jpg') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), filename);
  const res = await fetch(`${baseUrl}/v1/images`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;

  const keys = app.get(ApiKeyService);
  const created = await keys.create({
    name: `itest-${Date.now()}`,
    permissions: ['upload', 'delete'],
  });
  apiKey = created.plaintext;
}, 60_000);

afterAll(async () => {
  if (app !== undefined) {
    if (createdAssetIds.length > 0) {
      const prisma = app.get<PrismaClient>(PRISMA);
      await prisma.asset
        .deleteMany({ where: { id: { in: createdAssetIds } } })
        .catch(() => undefined);
    }
    await app.close();
  }
});

describe('health', () => {
  it('reports liveness without auth', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness when dependencies are reachable', async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('ready');
    expect(body.checks.database).toBe('ok');
    expect(body.checks.storage).toBe('ok');
  });
});

describe('authentication', () => {
  it('rejects an unauthenticated upload', async () => {
    const res = await fetch(`${baseUrl}/v1/images`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid key', async () => {
    const res = await fetch(`${baseUrl}/v1/images`, {
      method: 'POST',
      headers: { 'x-api-key': 'imgk_key_bogus_deadbeef' },
    });
    expect(res.status).toBe(401);
  });
});

describe('proxied upload', () => {
  it('stores a valid image and returns delivery urls', async () => {
    const { status, body } = await uploadProxied(await jpeg());
    expect(status).toBe(201);

    const asset = body['asset'] as Record<string, unknown>;
    createdAssetIds.push(asset['id'] as string);

    expect(asset['status']).toBe('stored');
    expect((asset['source'] as Record<string, unknown>)['format']).toBe('jpeg');
    expect((asset['urls'] as Record<string, unknown>)['srcset']).toContain('cdn.example.com');
  });

  it('rejects a file whose bytes are not an image', async () => {
    const { status, body } = await uploadProxied(
      Buffer.from('%PDF-1.4 not an image'),
      'image/jpeg',
    );
    expect(status).toBe(422);
    expect((body['error'] as Record<string, unknown>)['code']).toBe('unsupported_format');
  });

  it('rejects a content-type/content mismatch', async () => {
    // Real PNG bytes, but the client claims JPEG.
    const png = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    const { status, body } = await uploadProxied(png, 'image/jpeg', 'lies.jpg');
    expect(status).toBe(422);
    expect((body['error'] as Record<string, unknown>)['code']).toBe('content_type_mismatch');
  });

  it('deduplicates identical bytes', async () => {
    const bytes = await jpeg(640, 480);

    const first = await uploadProxied(bytes);
    const second = await uploadProxied(bytes);

    const firstId = (first.body['asset'] as Record<string, unknown>)['id'];
    createdAssetIds.push(firstId as string);

    expect(second.body['duplicate']).toBe(true);
    expect((second.body['asset'] as Record<string, unknown>)['id']).toBe(firstId);
  });
});

describe('lifecycle', () => {
  let assetId: string;

  it('creates an asset to operate on', async () => {
    const { body } = await uploadProxied(await jpeg(1200, 800));
    assetId = (body['asset'] as Record<string, unknown>)['id'] as string;
    createdAssetIds.push(assetId);
    expect(assetId).toBeDefined();
  });

  it('fetches metadata', async () => {
    const res = await fetch(`${baseUrl}/v1/images/${assetId}`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(res.status).toBe(200);
    const asset = (await res.json()) as Record<string, unknown>;
    expect(asset['id']).toBe(assetId);
  });

  it('updates alt text without bumping the version', async () => {
    const res = await fetch(`${baseUrl}/v1/images/${assetId}`, {
      method: 'PATCH',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ altText: 'a blue rectangle' }),
    });
    expect(res.status).toBe(200);
    const asset = (await res.json()) as Record<string, unknown>;
    expect(asset['altText']).toBe('a blue rectangle');
    expect(asset['version']).toBe(1);
  });

  it('returns 404 for an unknown asset', async () => {
    const res = await fetch(`${baseUrl}/v1/images/img_does_not_exist`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(res.status).toBe(404);
  });

  it('requires the delete permission on a key that lacks it', async () => {
    const keys = app.get(ApiKeyService);
    const readOnly = await keys.create({ name: 'readonly', permissions: ['upload'] });

    const res = await fetch(`${baseUrl}/v1/images/${assetId}`, {
      method: 'DELETE',
      headers: { 'x-api-key': readOnly.plaintext },
    });
    expect(res.status).toBe(403);
  });

  it('deletes the asset and stops serving it', async () => {
    const del = await fetch(`${baseUrl}/v1/images/${assetId}`, {
      method: 'DELETE',
      headers: { 'x-api-key': apiKey },
    });
    expect(del.status).toBe(200);

    const after = await fetch(`${baseUrl}/v1/images/${assetId}`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(after.status).toBe(404);
  });
});

describe('presigned upload', () => {
  it('runs the full presigned flow', async () => {
    const create = await fetch(`${baseUrl}/v1/images/uploads`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg' }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      assetId: string;
      upload: { url: string; fields: Record<string, string> };
    };
    createdAssetIds.push(created.assetId);

    // Upload the bytes straight to S3 using the presigned POST.
    const form = new FormData();
    for (const [k, v] of Object.entries(created.upload.fields)) form.append(k, v);
    form.append('file', new Blob([await jpeg(400, 300)], { type: 'image/jpeg' }));
    const put = await fetch(created.upload.url, { method: 'POST', body: form });
    expect(put.status).toBeLessThan(300);

    const complete = await fetch(`${baseUrl}/v1/images/uploads/${created.assetId}/complete`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg' }),
    });
    expect(complete.status).toBe(201);
    const body = (await complete.json()) as { asset: Record<string, unknown> };
    expect(body.asset['status']).toBe('stored');
  });
});

describe('quota enforcement', () => {
  it('rejects an upload once the asset quota is exhausted', async () => {
    const keys = app.get(ApiKeyService);
    const limited = await keys.create({ name: 'limited', permissions: ['upload'], maxAssets: 1 });

    const form1 = new FormData();
    form1.append('file', new Blob([await jpeg(320, 240)], { type: 'image/jpeg' }), 'a.jpg');
    const first = await fetch(`${baseUrl}/v1/images`, {
      method: 'POST',
      headers: { 'x-api-key': limited.plaintext },
      body: form1,
    });
    expect(first.status).toBe(201);
    createdAssetIds.push(((await first.json()) as { asset: { id: string } }).asset.id);

    const form2 = new FormData();
    form2.append('file', new Blob([await jpeg(48, 48)], { type: 'image/jpeg' }), 'b.jpg');
    const second = await fetch(`${baseUrl}/v1/images`, {
      method: 'POST',
      headers: { 'x-api-key': limited.plaintext },
      body: form2,
    });
    expect(second.status).toBe(413);
  });
});
