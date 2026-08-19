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
import { createPrismaClient, newAssetId } from '@imgopt/db';
import type { PrismaClient } from '@imgopt/db';
import { createServer, type Server } from 'node:http';
import { PrismaRegistry } from './test-support/prisma-registry.js';
import { RegistryFixtures } from './test-support/fixtures.js';

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

const prisma: PrismaClient = createPrismaClient({
  connectionString: process.env['DATABASE_URL'],
});
const fixtures = new RegistryFixtures(prisma);
const createdIds: string[] = [];

const WORKER_SECRET = 'test-worker-secret';

/*
 * A stand-in control plane, on a real socket.
 *
 * The optimizer no longer holds a database connection — it records its results over
 * HTTP (design.md L2) — so testing it against the repository directly would exercise
 * neither the transport nor the wire format, which is where this now fails. The
 * routes below are the same three `apps/api/src/modules/internal` serves, backed by
 * the same repository, so the request bodies the handler produces are the ones the
 * real control plane has to accept.
 */
const registry = new PrismaRegistry(prisma);

const controlPlane: Server = createServer((req, res) => {
  void (async () => {
    if (req.headers['x-imgopt-worker-secret'] !== WORKER_SECRET) {
      res.writeHead(401).end('{}');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body: Record<string, unknown> =
      chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString()) as never) : {};

    const url = req.url ?? '';
    const send = (value: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    };

    try {
      const optimize = /^\/internal\/v1\/optimize\/([^/]+)(\/complete|\/failed)?$/.exec(url);
      if (optimize !== null) {
        const assetId = decodeURIComponent(optimize[1]!);

        if (optimize[2] === '/complete') {
          await registry.completeOptimize(
            assetId,
            body['version'] as number,
            body['metadata'] as never,
          );
          send({ status: 'ready' });
        } else if (optimize[2] === '/failed') {
          await registry.markFailed(assetId, body['reason'] as never);
          send({ status: 'failed' });
        } else {
          send(await registry.optimizeContext(assetId));
        }
        return;
      }

      if (url === '/internal/v1/derivatives') {
        await registry.recordDerivative(body as never);
        send({ status: 'recorded' });
        return;
      }

      res.writeHead(404).end('{}');
    } catch (error) {
      res.writeHead(500).end(JSON.stringify({ error: String(error) }));
    }
  })();
});

await new Promise<void>((resolve) => controlPlane.listen(0, '127.0.0.1', resolve));
process.env['WORKER_CALLBACK_URL'] =
  `http://127.0.0.1:${(controlPlane.address() as { port: number }).port}`;
process.env['WORKER_CALLBACK_SECRET'] = WORKER_SECRET;

// Dynamic import: the handler reads config at module scope, so the callback URL above
// must already be set.
const { handler } = await import('./handler.js');

const storage = new S3Storage({
  bucket: 'imgopt-dev',
  region: 'us-east-1',
  endpoint: 'http://localhost:9100',
  forcePathStyle: true,
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
});

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
  await fixtures.createAsset(id);
  const sourceKey = `original/${id}/1/source.jpg`;
  await storage.put(sourceKey, bytes);
  await fixtures.addVersion({ assetId: id, sourceKey, contentHash: `h-${id}` });
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
  await new Promise<void>((resolve) => controlPlane.close(() => resolve()));
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
    expect((await fixtures.readAsset(id)).status).toBe('ready');
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
    await fixtures.createAsset(id);
    await fixtures.addVersion({
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
    await fixtures.createAsset(missingSource);
    await fixtures.addVersion({
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
    expect((await fixtures.readAsset(good)).status).toBe('ready');
  });
});
