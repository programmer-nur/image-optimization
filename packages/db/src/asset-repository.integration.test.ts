/**
 * Integration tests against the local PostgreSQL instance.
 *
 * Run `pnpm dev:up` and apply migrations first. These run against a real database
 * because the behaviours worth testing here are database behaviours: transactional
 * version bumps, cascade deletes, composite keys, and JSON null semantics.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AssetNotFoundError, UnscopedAssetRepository } from './asset-repository.js';
import { createPrismaClient } from './client.js';
import { AssetStatus, DerivativeOrigin } from './generated/enums.js';
import { newAssetId } from './ids.js';
import { DEFAULT_TENANT_ID } from './tenant-scope.js';
import { IllegalStatusTransition } from './status.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://imgopt:imgopt@localhost:5434/imgopt';

const prisma = createPrismaClient({ connectionString: DATABASE_URL });
const repo = new UnscopedAssetRepository(prisma);

/** Isolates a run so parallel runs and leftovers cannot interfere. */
const RUN = Math.random().toString(36).slice(2, 8);
const createdIds: string[] = [];

async function makeAsset(): Promise<string> {
  const asset = await repo.create({ tenantId: DEFAULT_TENANT_ID, tags: [`run-${RUN}`] });
  createdIds.push(asset.id);
  return asset.id;
}

/** Moves an asset to `stored` with a version, the usual starting point. */
async function makeStored(hash = `hash-${RUN}-${Math.random()}`): Promise<string> {
  const id = await makeAsset();
  await repo.addVersion({
    assetId: id,
    sourceKey: `original/${id}/1/source.jpg`,
    contentHash: hash,
    metadata: { width: 1600, height: 900, format: 'jpeg', bytes: 240_000 },
  });
  return id;
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`.catch((error: unknown) => {
    throw new Error(
      `Cannot reach Postgres at ${DATABASE_URL}. Run "pnpm dev:up" and "pnpm --filter @imgopt/db db:migrate". (${String(error)})`,
    );
  });
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await prisma.asset.deleteMany({ where: { id: { in: createdIds } } });
  }
  await prisma.$disconnect();
});

beforeEach(() => {
  createdIds.length = 0;
});

describe('create', () => {
  it('reserves an id before any bytes exist', async () => {
    const asset = await prisma.asset.findUnique({ where: { id: await makeAsset() } });

    expect(asset?.status).toBe(AssetStatus.pending_upload);
    expect(asset?.currentVersion).toBe(0);
  });

  it('accepts a caller-supplied id', async () => {
    const id = newAssetId();
    createdIds.push(id);
    const asset = await repo.create({ tenantId: DEFAULT_TENANT_ID, id });

    expect(asset.id).toBe(id);
  });

  it('stores tags and alt text', async () => {
    const id = newAssetId();
    createdIds.push(id);
    await repo.create({
      tenantId: DEFAULT_TENANT_ID,
      id,
      altText: 'a cat',
      tags: ['pets', 'hero'],
    });

    const asset = await repo.findById(id);
    expect(asset?.altText).toBe('a cat');
    expect(asset?.tags).toEqual(['pets', 'hero']);
  });
});

describe('versions', () => {
  it('advances the version and status together', async () => {
    const id = await makeStored();
    const asset = await repo.findById(id);

    expect(asset?.currentVersion).toBe(1);
    expect(asset?.status).toBe(AssetStatus.stored);
  });

  it('mints a new version rather than mutating the old one', async () => {
    const id = await makeStored();
    const first = await repo.currentVersion(id);

    await repo.addVersion({
      assetId: id,
      sourceKey: `original/${id}/2/source.png`,
      contentHash: `replacement-${RUN}`,
    });

    const asset = await repo.findById(id);
    expect(asset?.currentVersion).toBe(2);

    // The original row survives untouched: in-flight HTML referencing v1 must not
    // start 404ing the moment a replacement lands.
    const stillThere = await prisma.assetVersion.findUnique({
      where: { assetId_version: { assetId: id, version: 1 } },
    });
    expect(stillThere?.sourceKey).toBe(first?.sourceKey);
  });

  it('records intrinsic metadata', async () => {
    const id = await makeStored();
    const version = await repo.currentVersion(id);

    expect(version?.width).toBe(1600);
    expect(version?.height).toBe(900);
    expect(version?.bytes).toBe(240_000n);
  });

  it('fills in metadata discovered during processing', async () => {
    const id = await makeStored();
    await repo.updateVersionMetadata(id, 1, {
      lqip: 'data:image/webp;base64,AAAA',
      dominantColor: '3366cc',
      masterKey: `master/${id}/1/master.webp`,
    });

    const version = await repo.currentVersion(id);
    expect(version?.lqip).toBe('data:image/webp;base64,AAAA');
    expect(version?.masterKey).toContain('master/');
  });

  it('returns null for a version that does not exist yet', async () => {
    expect(await repo.currentVersion(await makeAsset())).toBeNull();
  });

  it('rejects an unknown asset', async () => {
    await expect(
      repo.addVersion({ assetId: 'img_nope', sourceKey: 'k', contentHash: 'h' }),
    ).rejects.toBeInstanceOf(AssetNotFoundError);
  });
});

describe('status lifecycle', () => {
  it('moves stored -> ready', async () => {
    const id = await makeStored();
    const updated = await repo.markReady(id);

    expect(updated.status).toBe(AssetStatus.ready);
  });

  it('records a machine-readable rejection reason', async () => {
    const id = await makeAsset();
    const updated = await repo.markRejected(id, 'content_type_mismatch');

    expect(updated.status).toBe(AssetStatus.rejected);
    expect(updated.failureReason).toBe('content_type_mismatch');
  });

  it('records a failure reason and allows recovery', async () => {
    const id = await makeStored();
    await repo.markFailed(id, 'corrupt_source');

    // `failed` is recoverable — reprocess puts it back to stored.
    const recovered = await repo.transitionStatus(id, AssetStatus.stored);
    expect(recovered.status).toBe(AssetStatus.stored);
    expect(recovered.failureReason).toBeNull();
  });

  it('refuses an illegal transition', async () => {
    const id = await makeAsset();
    await repo.markRejected(id, 'unsupported_format');

    // `rejected` is terminal: retrying cannot help, so nothing may revive it.
    await expect(repo.transitionStatus(id, AssetStatus.ready)).rejects.toBeInstanceOf(
      IllegalStatusTransition,
    );
  });

  it('refuses to resurrect a deleted asset', async () => {
    const id = await makeStored();
    await repo.softDelete(id);

    await expect(repo.transitionStatus(id, AssetStatus.ready)).rejects.toBeInstanceOf(
      IllegalStatusTransition,
    );
  });
});

describe('soft delete', () => {
  it('hides the asset from normal reads', async () => {
    const id = await makeStored();
    await repo.softDelete(id);

    expect(await repo.findById(id)).toBeNull();
    expect(await repo.findById(id, { includeDeleted: true })).not.toBeNull();
  });

  it('stamps a deletion time', async () => {
    const id = await makeStored();
    await repo.softDelete(id);

    const asset = await repo.findById(id, { includeDeleted: true });
    expect(asset?.deletedAt).toBeInstanceOf(Date);
  });
});

describe('editable metadata', () => {
  it('updates alt text without touching the version', async () => {
    const id = await makeStored();
    await repo.updateMetadata(id, { altText: 'updated copy' });

    const asset = await repo.findById(id);
    expect(asset?.altText).toBe('updated copy');
    // Cached derivatives must not be invalidated by an alt-text edit.
    expect(asset?.currentVersion).toBe(1);
  });

  it('round-trips a focal point', async () => {
    const id = await makeStored();
    await repo.updateMetadata(id, { focalPoint: { x: 0.25, y: 0.75 } });

    const asset = await repo.findById(id);
    expect(asset?.focalPoint).toEqual({ x: 0.25, y: 0.75 });
  });

  it('clears a focal point', async () => {
    const id = await makeStored();
    await repo.updateMetadata(id, { focalPoint: { x: 0.5, y: 0.5 } });
    await repo.updateMetadata(id, { focalPoint: null });

    const asset = await repo.findById(id);
    expect(asset?.focalPoint).toBeNull();
  });
});

describe('content-hash deduplication', () => {
  it('finds an existing asset with identical bytes', async () => {
    const hash = `dedupe-${RUN}`;
    const id = await makeStored(hash);

    const found = await repo.findByContentHash(hash);
    expect(found?.assetId).toBe(id);
  });

  it('returns null for unseen bytes', async () => {
    expect(await repo.findByContentHash(`never-seen-${RUN}`)).toBeNull();
  });

  it('ignores deleted assets', async () => {
    const hash = `dedupe-deleted-${RUN}`;
    await repo.softDelete(await makeStored(hash));

    expect(await repo.findByContentHash(hash)).toBeNull();
  });

  it('ignores a superseded version', async () => {
    const hash = `dedupe-superseded-${RUN}`;
    const id = await makeStored(hash);

    await repo.addVersion({
      assetId: id,
      sourceKey: `original/${id}/2/source.jpg`,
      contentHash: `newer-${RUN}`,
    });

    // v1's bytes are history now; re-uploading them should create a new asset
    // rather than resurrect a version nobody is serving.
    expect(await repo.findByContentHash(hash)).toBeNull();
  });
});

describe('derivatives', () => {
  it('records a derivative', async () => {
    const id = await makeStored();
    await repo.recordDerivative({
      canonicalKey: `derived/${id}/v1-1/w640_q75.avif`,
      assetId: id,
      version: 1,
      format: 'avif',
      width: 640,
      height: 360,
      bytes: 18_000,
      generatedBy: DerivativeOrigin.ondemand,
    });

    const rows = await repo.listDerivatives(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.generatedBy).toBe(DerivativeOrigin.ondemand);
  });

  it('is idempotent on the canonical key', async () => {
    const id = await makeStored();
    const key = `derived/${id}/v1-1/w640_q75.avif`;
    const record = {
      canonicalKey: key,
      assetId: id,
      version: 1,
      format: 'avif',
      bytes: 18_000,
      generatedBy: DerivativeOrigin.warm,
    };

    await repo.recordDerivative(record);
    await repo.recordDerivative({ ...record, bytes: 19_000 });

    // Concurrent generators may both report the same key; that must not duplicate.
    const rows = await repo.listDerivatives(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bytes).toBe(19_000n);
  });

  it('cascades away when the asset row is removed', async () => {
    const id = await makeStored();
    await repo.recordDerivative({
      canonicalKey: `derived/${id}/v1-1/w320_q75.avif`,
      assetId: id,
      version: 1,
      format: 'avif',
      bytes: 9_000,
      generatedBy: DerivativeOrigin.warm,
    });

    await prisma.asset.delete({ where: { id } });

    expect(await prisma.derivative.findMany({ where: { assetId: id } })).toHaveLength(0);
  });

  it('reports storage split the way the cost model splits it', async () => {
    const id = await makeStored();
    await repo.recordDerivative({
      canonicalKey: `derived/${id}/v1-1/w640_q75.avif`,
      assetId: id,
      version: 1,
      format: 'avif',
      bytes: 18_000,
      generatedBy: DerivativeOrigin.warm,
    });

    const footprint = await repo.storageFootprint(id);
    expect(footprint.originalBytes).toBe(240_000n);
    expect(footprint.derivativeBytes).toBe(18_000n);
    expect(footprint.derivativeCount).toBe(1);
  });
});

describe('listing', () => {
  it('orders newest first and paginates', async () => {
    const ids = [await makeStored(), await makeStored(), await makeStored()];

    const page = await repo.list({ limit: 2 });
    expect(page.assets.length).toBe(2);
    expect(page.nextCursor).toBeDefined();

    // ULIDs sort chronologically, so the newest asset leads without a timestamp sort.
    const newest = page.assets[0]!.id;
    expect(ids).toContain(newest);
    expect(newest >= page.assets[1]!.id).toBe(true);
  });

  it('excludes deleted assets by default', async () => {
    const id = await makeStored();
    await repo.softDelete(id);

    const page = await repo.list({ limit: 200 });
    expect(page.assets.map((a) => a.id)).not.toContain(id);
  });

  it('filters by status', async () => {
    const id = await makeStored();
    await repo.markReady(id);

    const page = await repo.list({ status: AssetStatus.ready, limit: 200 });
    expect(page.assets.every((a) => a.status === AssetStatus.ready)).toBe(true);
  });
});
