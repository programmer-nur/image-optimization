/**
 * Two tenants, one deployment (task 3.10).
 *
 * The scoping unit test proves each query carries a `tenantId`. This proves what that
 * buys, over HTTP, against a real database: two tenants uploading *byte-identical*
 * images get two assets, and neither can see the other's through any endpoint.
 *
 * Identical bytes are the sharp case. Deduplication matches on a content hash, so a
 * deployment-wide match would hand tenant B a reference to tenant A's asset — and, in
 * doing so, disclose that someone else already holds exactly those bytes. Two rows
 * costing two copies of the same object is the correct answer here.
 *
 * Run `pnpm dev:up` and apply migrations first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
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
process.env['LOG_LEVEL'] ??= 'error';
// The control plane refuses to start without this — serving the internal worker
// routes unauthenticated is worse than not starting at all.
process.env['WORKER_CALLBACK_SECRET'] ??= 'itest-worker-secret';

const { createApp } = await import('./app.factory.js');
const { ApiKeyService } = await import('./modules/auth/api-key.service.js');
const { PRISMA } = await import('./tokens.js');

const RUN = Date.now();
const TENANT_A = `tenant_a_${RUN}`;
const TENANT_B = `tenant_b_${RUN}`;

let app: NestFastifyApplication;
let prisma: PrismaClient;
let baseUrl: string;
let keyA: string;
let keyB: string;
let assetA: string;
let assetB: string;

const createdAssetIds: string[] = [];

/**
 * Deliberately deterministic: both tenants upload exactly these bytes.
 *
 * The dimensions are unique to this file so the image cannot collide with another
 * suite's fixture and be deduplicated onto an asset this test does not own — a real
 * failure mode that once made a quota test pass under both behaviours.
 */
async function identicalJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 411, height: 259, channels: 3, background: { r: 17, g: 85, b: 153 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function upload(key: string, bytes: Buffer) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'same.jpg');
  const res = await fetch(`${baseUrl}/v1/images`, {
    method: 'POST',
    headers: { 'x-api-key': key },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function asKey(key: string, method = 'GET', body?: unknown) {
  return {
    method,
    headers: {
      'x-api-key': key,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

beforeAll(async () => {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;

  prisma = app.get<PrismaClient>(PRISMA);
  for (const [id, slug] of [
    [TENANT_A, `a-${RUN}`],
    [TENANT_B, `b-${RUN}`],
  ]) {
    await prisma.tenant.create({ data: { id: id!, slug: slug!, name: slug! } });
  }

  const keys = app.get(ApiKeyService);
  keyA = (
    await keys.create({
      tenantId: TENANT_A,
      name: `tenancy-a-${RUN}`,
      permissions: ['read', 'upload', 'delete', 'admin'],
    })
  ).plaintext;
  keyB = (
    await keys.create({
      tenantId: TENANT_B,
      name: `tenancy-b-${RUN}`,
      permissions: ['read', 'upload', 'delete', 'admin'],
    })
  ).plaintext;

  const bytes = await identicalJpeg();
  const a = await upload(keyA, bytes);
  const b = await upload(keyB, bytes);

  expect(a.status).toBe(201);
  expect(b.status).toBe(201);

  assetA = (a.body['asset'] as { id: string }).id;
  assetB = (b.body['asset'] as { id: string }).id;
  createdAssetIds.push(assetA, assetB);
}, 120_000);

afterAll(async () => {
  if (app === undefined) return;

  await prisma.asset.deleteMany({ where: { id: { in: createdAssetIds } } }).catch(() => undefined);
  await prisma.apiKey
    .deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } })
    .catch(() => undefined);
  await prisma.tenant
    .deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } })
    .catch(() => undefined);
  await app.close();
});

describe('deduplication is per tenant', () => {
  it('gives two tenants two assets for identical bytes', () => {
    expect(assetA).not.toBe(assetB);
  });

  it('did not report the second upload as a duplicate', async () => {
    // Re-uploading the *same* bytes as the *same* tenant still dedupes — proving the
    // scoping narrowed the match rather than disabling the feature.
    const again = await upload(keyB, await identicalJpeg());
    expect(again.status).toBe(201);
    expect(again.body['duplicate']).toBe(true);
    expect((again.body['asset'] as { id: string }).id).toBe(assetB);
  });

  it('stored both assets under their own tenant', async () => {
    const rows = await prisma.asset.findMany({
      where: { id: { in: [assetA, assetB] } },
      select: { id: true, tenantId: true },
    });
    expect(new Map(rows.map((r) => [r.id, r.tenantId]))).toEqual(
      new Map([
        [assetA, TENANT_A],
        [assetB, TENANT_B],
      ]),
    );
  });
});

/*
 * Every read and write route, from the wrong tenant.
 *
 * Enumerated rather than sampled, and asserted as 404 rather than "not 200": a 403
 * would also keep the bytes safe while confirming the id exists, which is the single
 * bit an enumeration attempt is trying to learn.
 */
describe("tenant B cannot reach tenant A's asset", () => {
  const routes: Array<[string, string, unknown?]> = [
    ['GET', ''],
    ['GET', '/variants'],
    ['PATCH', '', { altText: 'stolen' }],
    ['POST', '/reprocess'],
    ['DELETE', ''],
  ];

  it.each(routes)('%s /v1/images/:id%s answers 404', async (method, suffix, body) => {
    const res = await fetch(`${baseUrl}/v1/images/${assetA}${suffix}`, asKey(keyB, method, body));
    expect(res.status).toBe(404);
  });

  it('answers 404 for a source replacement', async () => {
    const res = await fetch(`${baseUrl}/v1/images/${assetA}/source`, {
      method: 'PUT',
      headers: { 'x-api-key': keyB, 'content-type': 'image/jpeg' },
      body: await identicalJpeg(),
    });
    expect(res.status).toBe(404);
  });

  it('leaves the asset untouched after every attempt', async () => {
    const res = await fetch(`${baseUrl}/v1/images/${assetA}`, asKey(keyA));
    expect(res.status).toBe(200);
    const asset = (await res.json()) as { altText: string | null; status: string };
    expect(asset.altText).toBeNull();
    expect(asset.status).not.toBe('deleted');
  });
});

describe('listing', () => {
  it("never includes the other tenant's assets", async () => {
    for (const [key, mine, theirs] of [
      [keyA, assetA, assetB],
      [keyB, assetB, assetA],
    ]) {
      const res = await fetch(`${baseUrl}/v1/images?limit=200`, asKey(key!));
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as { assets: Array<{ id: string }> }).assets.map((a) => a.id);

      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
    }
  });

  it("a cursor from one tenant cannot page into another's", async () => {
    // The cursor is an asset id and is applied *inside* the tenant filter, so lifting
    // one from another tenant's response narrows the page rather than escaping it.
    const res = await fetch(`${baseUrl}/v1/images?limit=200&cursor=${assetA}`, asKey(keyB));
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { assets: Array<{ id: string }> }).assets.map((a) => a.id);
    expect(ids).not.toContain(assetA);
  });
});

describe('API keys', () => {
  it("does not list another tenant's keys", async () => {
    const res = await fetch(`${baseUrl}/v1/keys`, asKey(keyA));
    expect(res.status).toBe(200);
    const keys = ((await res.json()) as { keys: Array<{ name: string }> }).keys;

    expect(keys.map((k) => k.name)).toContain(`tenancy-a-${RUN}`);
    expect(keys.map((k) => k.name)).not.toContain(`tenancy-b-${RUN}`);
  });

  it("cannot revoke another tenant's key", async () => {
    const listed = (await (await fetch(`${baseUrl}/v1/keys`, asKey(keyB))).json()) as {
      keys: Array<{ id: string; name: string }>;
    };
    const bKeyId = listed.keys.find((k) => k.name === `tenancy-b-${RUN}`)?.id;
    expect(bKeyId).toBeDefined();

    const res = await fetch(`${baseUrl}/v1/keys/${bKeyId!}`, asKey(keyA, 'DELETE'));
    expect(res.status).toBe(404);
  });

  it('issues a new key into the issuer’s own tenant', async () => {
    const res = await fetch(
      `${baseUrl}/v1/keys`,
      asKey(keyA, 'POST', { name: `issued-${RUN}`, permissions: ['read'] }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { key: { id: string } };

    const row = await prisma.apiKey.findUnique({ where: { id: created.key.id } });
    expect(row?.tenantId).toBe(TENANT_A);
  });
});

describe('quota is the tenant’s, not the key’s', () => {
  it('charges the tenant when a second key uploads', async () => {
    const keys = app.get(ApiKeyService);
    const second = await keys.create({
      tenantId: TENANT_B,
      name: `tenancy-b2-${RUN}`,
      permissions: ['upload'],
    });

    const before = await prisma.tenant.findUnique({ where: { id: TENANT_B } });

    // Unique bytes, so this is a genuine new asset rather than a dedupe.
    const bytes = await sharp({
      create: { width: 433, height: 271, channels: 3, background: { r: 200, g: 30, b: 60 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const res = await upload(second.plaintext, bytes);
    expect(res.status).toBe(201);
    createdAssetIds.push((res.body['asset'] as { id: string }).id);

    const after = await prisma.tenant.findUnique({ where: { id: TENANT_B } });

    // The point of moving accounting off the key: a second key spends the same
    // allowance rather than receiving a fresh one.
    expect(after!.usedAssets).toBe(before!.usedAssets + 1);
    expect(after!.usedBytes > before!.usedBytes).toBe(true);
  });
});
