/**
 * The internal worker surface, end to end.
 *
 * This is the route the optimizer and generator take now that they hold no database
 * connection (design.md L2), so it carries their correctness rather than merely
 * exposing it: an asset only becomes `ready` because of a call made here, and a
 * derivative is only recorded because of one.
 *
 * Run `pnpm dev:up` and apply migrations first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DEFAULT_TENANT_ID, type PrismaClient } from '@imgopt/db';

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

/*
 * Deferred to whatever another suite already set.
 *
 * Vitest may run these files in one process, and `app.factory.js` reads its config
 * once at module load — so the first suite to import it fixes the secret for every
 * suite after it. Overwriting the variable here would leave this file presenting a
 * secret the already-constructed guard has never heard of, which shows up as a
 * uniform 401 that looks exactly like a broken guard.
 */
const SECRET = process.env['WORKER_CALLBACK_SECRET'] ?? 'internal-itest-secret';
process.env['WORKER_CALLBACK_SECRET'] = SECRET;

const { createApp } = await import('./app.factory.js');
const { ApiKeyService } = await import('./modules/auth/api-key.service.js');
const { PRISMA } = await import('./tokens.js');

let app: NestFastifyApplication;
let prisma: PrismaClient;
let baseUrl: string;
let apiKey: string;
let assetId: string;

const RUN = Date.now();
const createdIds: string[] = [];

function worker(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}/internal/v1${path}`, {
    ...init,
    headers: {
      'x-imgopt-worker-secret': SECRET,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  prisma = app.get<PrismaClient>(PRISMA);

  apiKey = (
    await app.get(ApiKeyService).create({
      tenantId: DEFAULT_TENANT_ID,
      name: `internal-itest-${RUN}`,
      permissions: ['read', 'upload'],
    })
  ).plaintext;

  // Planted directly: this suite is about the internal routes, not about upload.
  assetId = `asset_internal_${RUN}`;
  createdIds.push(assetId);
  await prisma.asset.create({
    data: { id: assetId, tenantId: DEFAULT_TENANT_ID, status: 'pending_upload' },
  });
  await prisma.assetVersion.create({
    data: {
      assetId,
      version: 1,
      sourceKey: `original/${assetId}/1/source.jpg`,
      contentHash: `hash-${RUN}`,
    },
  });
  await prisma.asset.update({
    where: { id: assetId },
    data: { currentVersion: 1, status: 'stored' },
  });
}, 60_000);

afterAll(async () => {
  if (app === undefined) return;
  await prisma.asset.deleteMany({ where: { id: { in: createdIds } } }).catch(() => undefined);
  await prisma.apiKey
    .deleteMany({ where: { name: `internal-itest-${RUN}` } })
    .catch(() => undefined);
  await app.close();
});

describe('authentication', () => {
  it('refuses a request with no secret', async () => {
    const res = await fetch(`${baseUrl}/internal/v1/optimize/${assetId}`);
    expect(res.status).toBe(401);
  });

  it('refuses a wrong secret', async () => {
    const res = await fetch(`${baseUrl}/internal/v1/optimize/${assetId}`, {
      headers: { 'x-imgopt-worker-secret': 'not-the-secret' },
    });
    expect(res.status).toBe(401);
  });

  it('refuses a secret of the wrong length without leaking the difference', async () => {
    // Length is checked before the constant-time compare, since `timingSafeEqual`
    // throws on a mismatch. Both paths must answer identically.
    const res = await fetch(`${baseUrl}/internal/v1/optimize/${assetId}`, {
      headers: { 'x-imgopt-worker-secret': 'short' },
    });
    expect(res.status).toBe(401);
  });

  it('refuses a customer API key', async () => {
    // The two credential types are not interchangeable: an API key is scoped to a
    // tenant, and these routes are deliberately unscoped.
    const res = await fetch(`${baseUrl}/internal/v1/optimize/${assetId}`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(res.status).toBe(401);
  });

  it('refuses the worker secret on the public API', async () => {
    const res = await fetch(`${baseUrl}/v1/images`, {
      headers: { 'x-imgopt-worker-secret': SECRET },
    });
    expect(res.status).toBe(401);
  });
});

describe('optimize context', () => {
  it('returns the source key and version for a stored asset', async () => {
    const res = await worker(`/optimize/${assetId}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { context: Record<string, unknown> | null };
    expect(body.context).toMatchObject({
      assetId,
      deletedAt: null,
      currentVersion: 1,
      version: 1,
      sourceKey: `original/${assetId}/1/source.jpg`,
    });
  });

  it('reports a missing asset as a reason, not a 404', async () => {
    // A moot job is acknowledged and skipped; a 404 would be indistinguishable from
    // the control plane misrouting, and one of those should be retried.
    const res = await worker('/optimize/asset_does_not_exist');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ context: null, reason: 'asset_not_found' });
  });

  it('answers calmly for a soft-deleted asset', async () => {
    /*
     * The regression this exists for.
     *
     * `currentVersion()` throws `AssetNotFoundError` for a soft-deleted asset, so a
     * context lookup that used it turned "the asset was deleted while queued" — a
     * routine race — into a 500, and from the optimizer's side into a retry loop that
     * ends at the dead-letter queue. The context must carry `deletedAt` and let the
     * caller skip.
     */
    const id = `asset_deleted_${RUN}`;
    createdIds.push(id);
    await prisma.asset.create({
      data: { id, tenantId: DEFAULT_TENANT_ID, status: 'stored' },
    });
    await prisma.assetVersion.create({
      data: {
        assetId: id,
        version: 1,
        sourceKey: `original/${id}/1/s.jpg`,
        contentHash: `h-${id}`,
      },
    });
    await prisma.asset.update({
      where: { id },
      data: { currentVersion: 1, status: 'deleted', deletedAt: new Date() },
    });

    const res = await worker(`/optimize/${id}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { context: { deletedAt: string | null } | null };
    expect(body.context?.deletedAt).not.toBeNull();
  });

  it('distinguishes an asset with no stored version', async () => {
    const id = `asset_noversion_${RUN}`;
    createdIds.push(id);
    await prisma.asset.create({
      data: { id, tenantId: DEFAULT_TENANT_ID, status: 'pending_upload' },
    });

    const res = await worker(`/optimize/${id}`);
    expect(await res.json()).toEqual({ context: null, reason: 'no_version' });
  });
});

describe('completing a job', () => {
  it('records metadata and readiness together', async () => {
    const res = await worker(`/optimize/${assetId}/complete`, {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        metadata: { width: 800, height: 600, format: 'jpeg', bytes: 12345, lqip: 'data:x' },
      }),
    });
    expect(res.status).toBe(201);

    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    const version = await prisma.assetVersion.findUnique({
      where: { assetId_version: { assetId, version: 1 } },
    });

    expect(asset?.status).toBe('ready');
    expect(version?.width).toBe(800);
    expect(version?.lqip).toBe('data:x');
  });

  it('refuses to complete a version the asset has moved past', async () => {
    // SQS delivers at least once, so a redelivered job for a superseded version must
    // not overwrite the newer version's metadata or mark a stale source ready.
    const res = await worker(`/optimize/${assetId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ version: 99, metadata: { width: 1 } }),
    });

    expect(res.status).toBe(409);
  });

  it('rejects a body with no version', async () => {
    const res = await worker(`/optimize/${assetId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ metadata: {} }),
    });
    expect(res.status).toBe(400);
  });
});

describe('recording a derivative', () => {
  const canonicalKey = `derived/asset_internal_${RUN}/v1-1/w640_q75.webp`;

  it('records one', async () => {
    const res = await worker('/derivatives', {
      method: 'POST',
      body: JSON.stringify({
        canonicalKey,
        assetId,
        version: 1,
        format: 'webp',
        width: 640,
        height: 480,
        bytes: 4321,
        generatedBy: 'ondemand',
      }),
    });

    expect(res.status).toBe(201);
    const row = await prisma.derivative.findUnique({ where: { canonicalKey } });
    expect(row?.generatedBy).toBe('ondemand');
  });

  it('is idempotent', async () => {
    // Two viewers can miss the same key at the same instant and both generate it. A
    // conflict here must not become an error the generator has to reason about on a
    // viewer's critical path.
    const body = JSON.stringify({
      canonicalKey,
      assetId,
      version: 1,
      format: 'webp',
      bytes: 9999,
      generatedBy: 'ondemand',
    });

    expect((await worker('/derivatives', { method: 'POST', body })).status).toBe(201);
    const row = await prisma.derivative.findUnique({ where: { canonicalKey } });
    expect(row?.bytes).toBe(9999n);
  });

  it('rejects an incomplete record', async () => {
    const res = await worker('/derivatives', {
      method: 'POST',
      body: JSON.stringify({ canonicalKey: 'x', assetId }),
    });
    expect(res.status).toBe(400);
  });
});

describe('marking a job failed', () => {
  it('accepts a known reason', async () => {
    const id = `asset_failed_${RUN}`;
    createdIds.push(id);
    await prisma.asset.create({
      data: { id, tenantId: DEFAULT_TENANT_ID, status: 'stored', currentVersion: 1 },
    });

    const res = await worker(`/optimize/${id}/failed`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'corrupt_source' }),
    });

    expect(res.status).toBe(201);
    const asset = await prisma.asset.findUnique({ where: { id } });
    expect(asset?.status).toBe('failed');
    expect(asset?.failureReason).toBe('corrupt_source');
  });

  it('refuses an arbitrary reason', async () => {
    // The value lands in a column an operator reads during an incident; an arbitrary
    // string there is worse than no value at all.
    const res = await worker(`/optimize/${assetId}/failed`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'because' }),
    });
    expect(res.status).toBe(400);
  });
});
