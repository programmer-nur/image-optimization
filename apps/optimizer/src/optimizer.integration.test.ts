/**
 * Optimizer integration test.
 *
 * Runs the real worker against MinIO and Postgres with real images. Proves the warm
 * set, LQIP, conditional master, metadata, bookkeeping, idempotency, and terminal
 * failure handling all work together. Run `pnpm dev:up` and migrations first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { loadConfig, type AppConfig } from '@imgopt/config';
import { S3Storage } from '@imgopt/storage';
import {
  DEFAULT_TENANT_ID,
  UnscopedAssetRepository,
  createPrismaClient,
  newAssetId,
} from '@imgopt/db';
import type { PrismaClient } from '@imgopt/db';
import { toCanonicalKey, type TransformSpec } from '@imgopt/core';
import { Optimizer } from './optimizer.js';

process.env['AWS_REGION'] ??= 'us-east-1';
process.env['S3_BUCKET'] ??= 'imgopt-dev';
process.env['S3_ENDPOINT'] ??= 'http://localhost:9100';
process.env['S3_FORCE_PATH_STYLE'] ??= 'true';
process.env['AWS_ACCESS_KEY_ID'] ??= 'minioadmin';
process.env['AWS_SECRET_ACCESS_KEY'] ??= 'minioadmin';
process.env['DATABASE_URL'] ??= 'postgres://imgopt:imgopt@localhost:5434/imgopt';
process.env['SQS_OPTIMIZE_QUEUE_URL'] ??= 'http://localhost:9324/000000000000/imgopt-optimize';
process.env['CDN_HOST'] ??= 'cdn.example.com';
process.env['WARM_WIDTHS'] ??= '640,1080';
process.env['WARM_FORMATS'] ??= 'avif,webp';
process.env['MASTER_THRESHOLD_LONGEST_EDGE'] ??= '2000';
process.env['MASTER_LONGEST_EDGE'] ??= '1500';
process.env['LOG_LEVEL'] ??= 'silent';

const config: AppConfig = loadConfig();
const storage = new S3Storage({
  bucket: config.storage.bucket,
  region: config.storage.region,
  endpoint: config.storage.endpoint!,
  forcePathStyle: true,
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
});
const prisma: PrismaClient = createPrismaClient({ connectionString: config.database.url });
const repo = new UnscopedAssetRepository(prisma);
const noopLogger = { info() {}, warn() {}, error() {} };
const optimizer = new Optimizer(storage, repo, config, noopLogger);

const createdIds: string[] = [];

/** Creates a stored asset with the given bytes at version 1, ready to optimize. */
async function storeAsset(bytes: Buffer, ext = 'jpg'): Promise<string> {
  const id = newAssetId();
  createdIds.push(id);
  await repo.create({ tenantId: DEFAULT_TENANT_ID, id });
  const sourceKey = `original/${id}/1/source.${ext}`;
  await storage.put(sourceKey, bytes, { contentType: 'image/jpeg' });
  await repo.addVersion({
    assetId: id,
    sourceKey,
    contentHash: `hash-${id}`,
    metadata: { format: 'jpeg', bytes: bytes.length },
  });
  return id;
}

async function photo(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 140, b: 60 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`.catch((error: unknown) => {
    throw new Error(`Cannot reach Postgres. Run "pnpm dev:up" + migrations. (${String(error)})`);
  });
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await prisma.asset.deleteMany({ where: { id: { in: createdIds } } }).catch(() => undefined);
    for (const id of createdIds)
      await storage.deletePrefix(`original/${id}/`).catch(() => undefined);
    for (const id of createdIds)
      await storage.deletePrefix(`derived/${id}/`).catch(() => undefined);
    for (const id of createdIds) await storage.deletePrefix(`master/${id}/`).catch(() => undefined);
  }
  storage.destroy();
  await prisma.$disconnect();
});

function job(assetId: string, assetVersion = 1) {
  return { assetId, assetVersion, correlationId: `corr-${assetId}` };
}

describe('warm set', () => {
  it('generates metadata, LQIP, and the configured derivatives', async () => {
    const id = await storeAsset(await photo(1600, 900));

    const outcome = await optimizer.process(job(id));
    expect(outcome.status).toBe('processed');

    const version = await repo.currentVersion(id);
    expect(version?.width).toBe(1600);
    expect(version?.height).toBe(900);
    expect(version?.hasAlpha).toBe(false);
    expect(version?.lqip?.startsWith('data:image/webp;base64,')).toBe(true);
    expect(version?.dominantColor).toMatch(/^[0-9a-f]{6}$/);

    // 2 widths x 2 formats = 4 derivatives at the canonical keys.
    const asset = await repo.requireById(id);
    expect(asset.status).toBe('ready');
    for (const width of [640, 1080]) {
      for (const format of ['avif', 'webp'] as const) {
        const spec: TransformSpec = { width, format, quality: 75 };
        const key = toCanonicalKey({ assetId: id, assetVersion: 1, encoderEpoch: 1, spec });
        expect(await storage.exists(key), `${key} missing`).toBe(true);
      }
    }
  });

  it('records derivative bookkeeping', async () => {
    const id = await storeAsset(await photo(1200, 800));
    await optimizer.process(job(id));

    const rows = await repo.listDerivatives(id);
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.generatedBy === 'warm')).toBe(true);
  });

  it('caps warm widths at the source, deduplicating and never upscaling', async () => {
    // 500px source: both configured widths (640, 1080) cap to 480. One width remains.
    const id = await storeAsset(await photo(500, 400));
    const outcome = await optimizer.process(job(id));
    expect(outcome.status).toBe('processed');

    const rows = await repo.listDerivatives(id);
    const widths = new Set(rows.map((r) => r.width));
    expect(widths.has(480)).toBe(true);
    expect([...widths].every((w) => (w ?? 0) <= 500)).toBe(true);
    // 1 unique width x 2 formats.
    expect(rows.length).toBe(2);
  });
});

describe('conditional master', () => {
  it('produces a master for a source above the threshold', async () => {
    const id = await storeAsset(await photo(3000, 2000));
    await optimizer.process(job(id));

    const version = await repo.currentVersion(id);
    expect(version?.masterKey).toBeDefined();
    expect(await storage.exists(version!.masterKey!)).toBe(true);

    const master = await storage.get(version!.masterKey!);
    const meta = await sharp(master).metadata();
    expect(Math.max(meta.width, meta.height)).toBe(1500);
  });

  it('produces no master for an ordinary source', async () => {
    const id = await storeAsset(await photo(1200, 800));
    await optimizer.process(job(id));

    const version = await repo.currentVersion(id);
    expect(version?.masterKey).toBeNull();
  });
});

describe('idempotency', () => {
  it('converges to the same state when run twice', async () => {
    const id = await storeAsset(await photo(1600, 900));

    const first = await optimizer.process(job(id));
    const second = await optimizer.process(job(id));

    expect(first.status).toBe('processed');
    expect(second.status).toBe('processed');

    // Reprocessing must not duplicate derivatives.
    const rows = await repo.listDerivatives(id);
    expect(rows.length).toBe(4);
  });
});

describe('skips', () => {
  it('skips a job for a superseded version', async () => {
    const id = await storeAsset(await photo(800, 600));
    // Advance to version 2 so the version-1 job is stale.
    await repo.addVersion({
      assetId: id,
      sourceKey: `original/${id}/2/source.jpg`,
      contentHash: `h2-${id}`,
    });

    const outcome = await optimizer.process(job(id, 1));
    expect(outcome).toEqual({ status: 'skipped', reason: 'stale_version' });
  });

  it('skips a deleted asset', async () => {
    const id = await storeAsset(await photo(800, 600));
    await repo.softDelete(id);

    const outcome = await optimizer.process(job(id));
    expect(outcome).toEqual({ status: 'skipped', reason: 'asset_deleted' });
  });

  it('skips an unknown asset', async () => {
    const outcome = await optimizer.process(job('img_nonexistent'));
    expect(outcome).toEqual({ status: 'skipped', reason: 'asset_not_found' });
  });
});

describe('terminal failure', () => {
  it('marks the asset failed for a corrupt source without asking for a retry', async () => {
    const id = newAssetId();
    createdIds.push(id);
    await repo.create({ tenantId: DEFAULT_TENANT_ID, id });
    const sourceKey = `original/${id}/1/source.jpg`;
    // Truncated JPEG: a real decode error, classified terminal.
    const truncated = (await photo(800, 600)).subarray(0, 200);
    await storage.put(sourceKey, truncated);
    await repo.addVersion({ assetId: id, sourceKey, contentHash: `h-${id}` });

    const outcome = await optimizer.process(job(id));
    expect(outcome.status).toBe('failed');
    expect(outcome).toMatchObject({ retriable: false });

    const asset = await repo.requireById(id);
    expect(asset.status).toBe('failed');
    expect(asset.failureReason).toBe('corrupt_source');
  });
});
