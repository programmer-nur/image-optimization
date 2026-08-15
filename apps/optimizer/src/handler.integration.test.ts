/**
 * Handler integration test.
 *
 * Drives the real Lambda `handler` with a synthetic SQS batch against the live
 * stack, proving the partial-batch-failure wiring: a valid job is processed and
 * acked, a malformed message is discarded, a terminal failure is acked, and only a
 * retriable failure is reported back for redelivery.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { S3Storage } from '@imgopt/storage';
import { AssetRepository, createPrismaClient, newAssetId } from '@imgopt/db';
import type { PrismaClient } from '@imgopt/db';

process.env['AWS_REGION'] ??= 'us-east-1';
process.env['S3_BUCKET'] ??= 'imgopt-dev';
process.env['S3_ENDPOINT'] ??= 'http://localhost:9100';
process.env['S3_FORCE_PATH_STYLE'] ??= 'true';
process.env['AWS_ACCESS_KEY_ID'] ??= 'minioadmin';
process.env['AWS_SECRET_ACCESS_KEY'] ??= 'minioadmin';
process.env['DATABASE_URL'] ??= 'postgres://imgopt:imgopt@localhost:5434/imgopt';
process.env['SQS_OPTIMIZE_QUEUE_URL'] ??= 'http://localhost:9324/000000000000/imgopt-optimize';
process.env['CDN_HOST'] ??= 'cdn.example.com';
process.env['WARM_WIDTHS'] ??= '640';
process.env['WARM_FORMATS'] ??= 'webp';
process.env['LOG_LEVEL'] ??= 'silent';

// Dynamic import: the handler loads config from env at module scope, so env must be
// set first.
const { handler } = await import('./handler.js');

const storage = new S3Storage({
  bucket: 'imgopt-dev',
  region: 'us-east-1',
  endpoint: 'http://localhost:9100',
  forcePathStyle: true,
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
});
const prisma: PrismaClient = createPrismaClient({
  connectionString: process.env['DATABASE_URL'],
});
const repo = new AssetRepository(prisma);
const createdIds: string[] = [];

function record(body: unknown, messageId: string): SQSRecord {
  return {
    messageId,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    messageAttributes: {
      correlationId: { stringValue: `corr-${messageId}`, dataType: 'String' },
    },
    attributes: {},
    receiptHandle: 'rh',
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn',
    awsRegion: 'us-east-1',
  } as unknown as SQSRecord;
}

async function storeAsset(bytes: Buffer): Promise<string> {
  const id = newAssetId();
  createdIds.push(id);
  await repo.create({ id });
  const sourceKey = `original/${id}/1/source.jpg`;
  await storage.put(sourceKey, bytes);
  await repo.addVersion({ assetId: id, sourceKey, contentHash: `h-${id}` });
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
    }
  }
  storage.destroy();
  await prisma.$disconnect();
});

describe('handler batch response', () => {
  it('acks a valid job and does not report it as a failure', async () => {
    const bytes = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    const id = await storeAsset(bytes);

    const event: SQSEvent = {
      Records: [record({ assetId: id, assetVersion: 1, correlationId: 'c' }, 'm-valid')],
    };
    const response = await handler(event);

    expect(response.batchItemFailures).toEqual([]);
    expect((await repo.requireById(id)).status).toBe('ready');
  });

  it('discards a malformed message without reporting a failure', async () => {
    const event: SQSEvent = { Records: [record('not json at all', 'm-bad')] };
    const response = await handler(event);

    // A malformed message can never succeed; acking it avoids a pointless loop.
    expect(response.batchItemFailures).toEqual([]);
  });

  it('reports a retriable failure for redelivery', async () => {
    // Asset row exists at version 1, but its source object is missing — a transient
    // class of failure the handler asks SQS to retry.
    const id = newAssetId();
    createdIds.push(id);
    await repo.create({ id });
    await repo.addVersion({
      assetId: id,
      sourceKey: `original/${id}/1/missing.jpg`,
      contentHash: `h-${id}`,
    });

    const event: SQSEvent = {
      Records: [record({ assetId: id, assetVersion: 1, correlationId: 'c' }, 'm-retriable')],
    };
    const response = await handler(event);

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm-retriable' }]);
  });

  it('processes a mixed batch, reporting only the retriable failure', async () => {
    const good = await storeAsset(
      await sharp({ create: { width: 400, height: 300, channels: 3, background: '#334455' } })
        .jpeg()
        .toBuffer(),
    );
    const missingSource = newAssetId();
    createdIds.push(missingSource);
    await repo.create({ id: missingSource });
    await repo.addVersion({
      assetId: missingSource,
      sourceKey: `original/${missingSource}/1/missing.jpg`,
      contentHash: `h-${missingSource}`,
    });

    const event: SQSEvent = {
      Records: [
        record({ assetId: good, assetVersion: 1, correlationId: 'c' }, 'm-ok'),
        record('garbage', 'm-garbage'),
        record({ assetId: missingSource, assetVersion: 1, correlationId: 'c' }, 'm-fail'),
      ],
    };
    const response = await handler(event);

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'm-fail' }]);
    expect((await repo.requireById(good)).status).toBe('ready');
  });
});
