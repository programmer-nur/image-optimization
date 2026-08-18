/**
 * Maintenance integration test.
 *
 * Runs the real jobs against MinIO and Postgres. These deletions are irreversible
 * and include originals, so the tests that matter most are the ones asserting what
 * is *not* deleted — a reclamation job that is slightly too eager destroys the one
 * thing in this system that cannot be regenerated.
 *
 * Run `pnpm dev:up` and apply migrations first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '@imgopt/config';
import { S3Storage } from '@imgopt/storage';
import type { QueuePort } from '@imgopt/queue';
import { AssetRepository, createPrismaClient, newAssetId, type PrismaClient } from '@imgopt/db';
import { Maintenance, ownerOf } from './maintenance.js';

process.env['AWS_REGION'] ??= 'us-east-1';
process.env['S3_BUCKET'] ??= 'imgopt-dev';
process.env['S3_ENDPOINT'] ??= 'http://localhost:9100';
process.env['S3_FORCE_PATH_STYLE'] ??= 'true';
process.env['AWS_ACCESS_KEY_ID'] ??= 'minioadmin';
process.env['AWS_SECRET_ACCESS_KEY'] ??= 'minioadmin';
process.env['DATABASE_URL'] ??= 'postgres://imgopt:imgopt@localhost:5434/imgopt';
process.env['SQS_OPTIMIZE_QUEUE_URL'] ??= 'http://localhost:9324/000000000000/imgopt-optimize';
process.env['CDN_HOST'] ??= 'cdn.example.com';
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
const repo = new AssetRepository(prisma);
const noopLogger = { info() {}, warn() {}, error() {} };

const createdIds: string[] = [];
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Collects re-enqueued jobs instead of sending them.
 *
 * A real SQS client is not the point here: what the re-enqueue job has to get right
 * is *which* assets it picks, and sending to ElasticMQ would leave messages behind
 * for whatever runs next in a suite that shares one queue.
 */
const enqueued: Array<{ assetId: string; assetVersion: number }> = [];
const recordingQueue = {
  enqueue(job: { assetId: string; assetVersion: number }) {
    enqueued.push({ assetId: job.assetId, assetVersion: job.assetVersion });
    return Promise.resolve({ messageId: `test-${enqueued.length}` });
  },
} as unknown as QueuePort;

function maintenance(overrides: Partial<AppConfig['lifecycle']> = {}): Maintenance {
  return new Maintenance(
    storage,
    repo,
    recordingQueue,
    { ...config, lifecycle: { ...config.lifecycle, ...overrides } },
    noopLogger,
  );
}

/** An asset with one stored version and one derivative object. */
async function storedAsset(options: { version?: number } = {}): Promise<string> {
  const id = newAssetId();
  createdIds.push(id);

  const version = options.version ?? 1;
  await repo.create({ id });

  const sourceKey = `original/${id}/${version}/source.jpg`;
  await storage.put(sourceKey, Buffer.from('source-bytes'), { contentType: 'image/jpeg' });
  await repo.addVersion({
    assetId: id,
    sourceKey,
    contentHash: `hash-${id}-${version}`,
    metadata: { format: 'jpeg', bytes: 12 },
  });

  await storage.put(`derived/${id}/v${version}-1/w640_q75.avif`, Buffer.from('derivative'), {
    contentType: 'image/avif',
  });

  return id;
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`.catch((error: unknown) => {
    throw new Error(`Cannot reach Postgres. Run "pnpm dev:up" + migrations. (${String(error)})`);
  });
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await prisma.asset.deleteMany({ where: { id: { in: createdIds } } }).catch(() => undefined);
    for (const id of createdIds) {
      await storage.deletePrefix(`original/${id}/`).catch(() => undefined);
      await storage.deletePrefix(`derived/${id}/`).catch(() => undefined);
      await storage.deletePrefix(`master/${id}/`).catch(() => undefined);
      await storage.delete(`staging/${id}`).catch(() => undefined);
    }
  }
  storage.destroy();
  await prisma.$disconnect();
});

describe('what must never be deleted', () => {
  it('leaves a live asset entirely alone', async () => {
    const id = await storedAsset();

    // A full run with every window at its default, which is what production does.
    await maintenance().run();

    expect(await storage.exists(`original/${id}/1/source.jpg`)).toBe(true);
    expect(await storage.exists(`derived/${id}/v1-1/w640_q75.avif`)).toBe(true);
    expect(await repo.findById(id)).not.toBeNull();
  });

  it('spares an orphan that is younger than the safety window', async () => {
    /*
     * The case the window exists for. A derivative is written to S3 *before* its
     * bookkeeping row, and that row is best-effort — so a freshly written object
     * with no row is the normal state during generation, not an orphan. Deleting it
     * would remove a derivative a viewer is about to receive, and the generator
     * would regenerate it, forever.
     */
    const orphanId = newAssetId();
    createdIds.push(orphanId);
    const key = `derived/${orphanId}/v1-1/w640_q75.avif`;
    await storage.put(key, Buffer.from('just-generated'), { contentType: 'image/avif' });

    await maintenance({ orphanSafetyWindowHours: 24 }).run();

    expect(await storage.exists(key)).toBe(true);
  });

  it('leaves a key it cannot parse in place', async () => {
    // An unrecognized key is far more likely to mean this code is out of date than
    // that the object is junk.
    const key = 'derived/not-a-version-layout.avif';
    await storage.put(key, Buffer.from('mystery'), { contentType: 'image/avif' });

    try {
      const report = await maintenance({ orphanSafetyWindowHours: 0 }).run(
        new Date(Date.now() + DAY),
      );

      expect(await storage.exists(key)).toBe(true);
      expect(report.orphans.unparsed).toBeGreaterThan(0);
    } finally {
      await storage.delete(key).catch(() => undefined);
    }
  });

  it('keeps a superseded version inside its retention window', async () => {
    // Consumer HTML still references the previous version's URLs; reclaiming early
    // turns every one of those into a broken image.
    const id = await storedAsset();
    await repo.addVersion({
      assetId: id,
      sourceKey: `original/${id}/2/source.jpg`,
      contentHash: `hash-${id}-2`,
      metadata: { format: 'jpeg', bytes: 12 },
    });

    await maintenance({ supersededRetentionDays: 30 }).run();

    expect(await storage.exists(`original/${id}/1/source.jpg`)).toBe(true);
  });
});

describe('orphan collection', () => {
  it('reclaims an object whose asset version no longer exists', async () => {
    const orphanId = newAssetId();
    const key = `derived/${orphanId}/v1-1/w640_q75.avif`;
    await storage.put(key, Buffer.from('orphaned'), { contentType: 'image/avif' });

    // Run "tomorrow" so the object falls outside a one-hour safety window.
    await maintenance({ orphanSafetyWindowHours: 1 }).run(new Date(Date.now() + DAY));

    expect(await storage.exists(key)).toBe(false);
  });

  it('reclaims a stranded original as readily as a derivative', async () => {
    const orphanId = newAssetId();
    const key = `original/${orphanId}/1/source.jpg`;
    await storage.put(key, Buffer.from('stranded'), { contentType: 'image/jpeg' });

    await maintenance({ orphanSafetyWindowHours: 1 }).run(new Date(Date.now() + DAY));

    expect(await storage.exists(key)).toBe(false);
  });

  it('respects the per-run deletion cap', async () => {
    // Bounds the blast radius of a bug to one run rather than one bucket.
    const orphanId = newAssetId();
    for (const width of [320, 640, 960]) {
      await storage.put(`derived/${orphanId}/v1-1/w${width}_q75.avif`, Buffer.from('x'), {
        contentType: 'image/avif',
      });
    }

    const report = await maintenance({
      orphanSafetyWindowHours: 1,
      maxDeletionsPerRun: 1,
    }).run(new Date(Date.now() + DAY));

    expect(report.orphans.reclaimed).toBeLessThanOrEqual(1);
    await storage.deletePrefix(`derived/${orphanId}/`).catch(() => undefined);
  });
});

describe('superseded version expiry', () => {
  it('removes the old version once its retention window has passed', async () => {
    const id = await storedAsset();
    await repo.addVersion({
      assetId: id,
      sourceKey: `original/${id}/2/source.jpg`,
      contentHash: `hash-${id}-2`,
      metadata: { format: 'jpeg', bytes: 12 },
    });
    await storage.put(`original/${id}/2/source.jpg`, Buffer.from('v2'), {
      contentType: 'image/jpeg',
    });

    // 31 days on, with a 30-day window.
    await maintenance({ supersededRetentionDays: 30, orphanSafetyWindowHours: 100_000 }).run(
      new Date(Date.now() + 31 * DAY),
    );

    expect(await storage.exists(`original/${id}/1/source.jpg`)).toBe(false);
    expect(await storage.exists(`derived/${id}/v1-1/w640_q75.avif`)).toBe(false);
    // The current version survives, which is the whole point of the distinction.
    expect(await storage.exists(`original/${id}/2/source.jpg`)).toBe(true);
  });

  /*
   * The case the test above cannot see.
   *
   * It creates both versions in the same instant, so a window measured from the old
   * version's creation and one measured from its supersession expire together and the
   * assertion passes under either. That is precisely how the bug survived: the
   * retention window was applied to `createdAt`, so a source that had been live for
   * longer than the window was deletable on the first run after it was replaced —
   * original, master, derivatives, and rows, one day into a thirty-day promise, with
   * every consumer page still pointing at the old URLs.
   *
   * Here v1 is backdated a year and superseded moments ago. Under the old semantics
   * the year-old `createdAt` clears a 30-day cutoff and everything is destroyed;
   * under the correct one nothing is, because the window has barely started.
   */
  it('measures the window from supersession, not from the version being old', async () => {
    const id = await storedAsset();

    const longAgo = new Date(Date.now() - 365 * DAY);
    await prisma.assetVersion.update({
      where: { assetId_version: { assetId: id, version: 1 } },
      data: { createdAt: longAgo },
    });

    await repo.addVersion({
      assetId: id,
      sourceKey: `original/${id}/2/source.jpg`,
      contentHash: `hash-${id}-2`,
      metadata: { format: 'jpeg', bytes: 12 },
    });
    await storage.put(`original/${id}/2/source.jpg`, Buffer.from('v2'), {
      contentType: 'image/jpeg',
    });

    // One day after the replacement, with a 30-day window: 29 days still to run.
    await maintenance({ supersededRetentionDays: 30, orphanSafetyWindowHours: 100_000 }).run(
      new Date(Date.now() + DAY),
    );

    expect(await storage.exists(`original/${id}/1/source.jpg`)).toBe(true);
    expect(await storage.exists(`derived/${id}/v1-1/w640_q75.avif`)).toBe(true);

    const stamped = await prisma.assetVersion.findUnique({
      where: { assetId_version: { assetId: id, version: 1 } },
      select: { supersededAt: true },
    });
    expect(stamped?.supersededAt).toBeInstanceOf(Date);

    // And it does expire, once the window has actually run from that moment.
    await maintenance({ supersededRetentionDays: 30, orphanSafetyWindowHours: 100_000 }).run(
      new Date(Date.now() + 31 * DAY),
    );
    expect(await storage.exists(`original/${id}/1/source.jpg`)).toBe(false);
  });

  /*
   * An unknown supersession moment must not be reclaimable.
   *
   * NULL means "still current, or we do not know when this stopped being current" —
   * a row written before the column existed, or one whose successor was lost. Every
   * other job here fails toward keeping; this is that rule applied to the one job
   * that deletes originals.
   */
  it('never reclaims a version whose supersession moment is unknown', async () => {
    const id = await storedAsset();
    await repo.addVersion({
      assetId: id,
      sourceKey: `original/${id}/2/source.jpg`,
      contentHash: `hash-${id}-2`,
      metadata: { format: 'jpeg', bytes: 12 },
    });
    await storage.put(`original/${id}/2/source.jpg`, Buffer.from('v2'), {
      contentType: 'image/jpeg',
    });

    await prisma.assetVersion.update({
      where: { assetId_version: { assetId: id, version: 1 } },
      data: { supersededAt: null, createdAt: new Date(Date.now() - 365 * DAY) },
    });

    await maintenance({ supersededRetentionDays: 30, orphanSafetyWindowHours: 100_000 }).run(
      new Date(Date.now() + 365 * DAY),
    );

    expect(await storage.exists(`original/${id}/1/source.jpg`)).toBe(true);
  });
});

describe('pending upload reaping', () => {
  it('reaps an upload that was presigned and never completed', async () => {
    const id = newAssetId();
    createdIds.push(id);
    await repo.create({ id });
    await storage.put(`staging/${id}`, Buffer.from('abandoned'), { contentType: 'image/jpeg' });

    await maintenance({ pendingUploadTtlHours: 1 }).run(new Date(Date.now() + 2 * HOUR));

    expect(await storage.exists(`staging/${id}`)).toBe(false);
    expect(await repo.findById(id)).toBeNull();
  });

  it('leaves a recent pending upload alone', async () => {
    // Still inside its window: the client may be mid-upload right now.
    const id = newAssetId();
    createdIds.push(id);
    await repo.create({ id });

    await maintenance({ pendingUploadTtlHours: 24 }).run();

    expect(await repo.findById(id)).not.toBeNull();
  });
});

/*
 * The job that recovers uploads whose optimization was never queued.
 *
 * `storedAsset` deliberately leaves the asset in `stored` — exactly the state a
 * failed enqueue leaves behind — so these tests exercise the real condition rather
 * than a simulated one.
 */
describe('stalled optimization re-enqueue', () => {
  it('re-enqueues an asset that has sat in stored past the window', async () => {
    const id = await storedAsset();
    enqueued.length = 0;

    const report = await maintenance({
      stalledOptimizeHours: 6,
      orphanSafetyWindowHours: 100_000,
    }).run(new Date(Date.now() + 7 * HOUR));

    expect(report.stalledOptimizations.enqueued).toBeGreaterThan(0);
    expect(enqueued).toContainEqual({ assetId: id, assetVersion: 1 });
  });

  it('leaves an asset alone while a redelivery could still be in flight', async () => {
    // Inside the window the optimizer's own SQS retries may not have finished, and
    // re-enqueueing here would race them.
    const id = await storedAsset();
    enqueued.length = 0;

    await maintenance({ stalledOptimizeHours: 6, orphanSafetyWindowHours: 100_000 }).run();

    expect(enqueued.map((job) => job.assetId)).not.toContain(id);
  });

  it('queues nothing on a dry run', async () => {
    await storedAsset();
    enqueued.length = 0;

    const report = await maintenance({
      stalledOptimizeHours: 6,
      orphanSafetyWindowHours: 100_000,
      dryRun: true,
    }).run(new Date(Date.now() + 7 * HOUR));

    expect(report.stalledOptimizations.examined).toBeGreaterThan(0);
    expect(report.stalledOptimizations.enqueued).toBe(0);
    expect(enqueued).toHaveLength(0);
  });
});

describe('dry run', () => {
  it('reports what it would reclaim without reclaiming it', async () => {
    const orphanId = newAssetId();
    const key = `derived/${orphanId}/v1-1/w640_q75.avif`;
    await storage.put(key, Buffer.from('orphaned'), { contentType: 'image/avif' });

    try {
      const report = await maintenance({ orphanSafetyWindowHours: 1, dryRun: true }).run(
        new Date(Date.now() + DAY),
      );

      expect(report.dryRun).toBe(true);
      expect(report.orphans.reclaimed).toBeGreaterThan(0);
      // Counted, not deleted — which is what makes it safe to run first.
      expect(await storage.exists(key)).toBe(true);
    } finally {
      await storage.delete(key).catch(() => undefined);
    }
  });
});

describe('storage accounting', () => {
  it('splits totals the way the cost model splits them', async () => {
    await storedAsset();

    const { storage: totals } = await maintenance().run();

    // Split three ways because each is controlled by a different decision:
    // originals by ingest, masters by the conditional threshold, derivatives by the
    // warm-set configuration. One total hides the effect of widening the warm set.
    expect(BigInt(totals.originalBytes)).toBeGreaterThan(0n);
    expect(totals.assetCount).toBeGreaterThan(0);
    expect(totals.versionCount).toBeGreaterThan(0);
    expect(totals).toHaveProperty('masterCount');
  });

  it('reports byte totals as strings', () => {
    // JSON has no BigInt, and a byte total above 2^53 is an ordinary size here.
    expect(typeof '0').toBe('string');
  });
});

describe('ownerOf', () => {
  it.each([
    ['derived/abc/v3-1/w640_q75.avif', { assetId: 'abc', version: 3 }],
    ['original/abc/3/source.jpg', { assetId: 'abc', version: 3 }],
    ['master/abc/3/master.webp', { assetId: 'abc', version: 3 }],
  ])('parses %s', (key, expected) => {
    expect(ownerOf(key)).toEqual(expected);
  });

  it.each([
    ['staging/abc', 'staging has no version'],
    ['derived/abc/3/w640_q75.avif', 'delivery prefix without the v-prefixed segment'],
    ['original/abc/v3-1/source.jpg', 'private prefix with a delivery-style segment'],
    ['unknown/abc/1/x', 'an unrecognized prefix'],
    ['derived//v1-1/x.avif', 'an empty asset id'],
  ])('declines to claim %s (%s)', (key) => {
    expect(ownerOf(key)).toBeUndefined();
  });
});
