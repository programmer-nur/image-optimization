/**
 * Scheduled entry point for reclamation.
 *
 * **This is the one worker that keeps a database connection**, and it runs next to the
 * database rather than in Lambda. That is not an exception to design.md L2 so much as
 * the reason L2 works: reclamation walks the whole registry (`liveVersionKeys`,
 * `aggregateStorage`) and issues deployment-wide deletes. It is batch database work
 * with a bucket scan attached, and giving it a remote interface would mean paging the
 * entire registry over HTTP to decide what to keep.
 *
 * It also decodes no images — it carries no sharp layer and never touches a pixel — so
 * nothing about it wanted Lambda's elasticity in the first place.
 *
 * Invoked on a schedule, not by traffic, so nothing here is latency-sensitive.
 * `runMaintenance` returns the report rather than logging and discarding it: the caller
 * then carries what was reclaimed, which is the first thing anyone wants after noticing
 * storage moved.
 */

import pino from 'pino';
import { loadConfig, requireDatabaseUrl } from '@imgopt/config';
import { S3Storage } from '@imgopt/storage';
import { SqsQueue } from '@imgopt/queue';
import { UnscopedAssetRepository, createPrismaClient } from '@imgopt/db';
import { Maintenance, type MaintenanceReport } from './maintenance.js';

const config = loadConfig();

const logger = pino({ level: config.logLevel, base: { component: 'maintenance' } });

const storage = new S3Storage({
  bucket: config.storage.bucket,
  region: config.storage.region,
  ...(config.storage.endpoint !== undefined ? { endpoint: config.storage.endpoint } : {}),
  forcePathStyle: config.storage.forcePathStyle,
});

// Only ever used to *send*: the reconciliation job re-enqueues optimizations whose
// original enqueue failed after the upload had already succeeded. This function is
// not a consumer of that queue and its role carries no receive permission.
const queue = new SqsQueue({
  queueUrl: config.queue.optimizeQueueUrl,
  region: config.storage.region,
  ...(config.queue.endpoint !== undefined ? { endpoint: config.queue.endpoint } : {}),
});

const prisma = createPrismaClient({
  // `container`, not `lambda`: this runs as a scheduled container beside the database,
  // where a small pool is right and the single-connection Lambda profile is not.
  connectionString: requireDatabaseUrl(config, 'The maintenance job'),
  context: 'container',
});

const maintenance = new Maintenance(
  storage,
  new UnscopedAssetRepository(prisma),
  queue,
  config,
  logger,
);

/** Runs one reclamation pass and returns what it reclaimed. */
export async function runMaintenance(): Promise<MaintenanceReport> {
  return maintenance.run();
}

/** Released on exit so a crashed run does not wedge the schedule. See `cli.ts`. */
export async function shutdown(): Promise<void> {
  storage.destroy();
  await prisma.$disconnect();
}

export { logger };
