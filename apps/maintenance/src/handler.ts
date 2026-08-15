/**
 * EventBridge-scheduled entry point.
 *
 * Invoked on a schedule, not by traffic, so nothing here is latency-sensitive and
 * the clients are constructed at module scope purely for warm-container reuse.
 *
 * Returns the report rather than swallowing it: the invocation record then carries
 * what was reclaimed, which is the first thing anyone wants after noticing storage
 * moved.
 */

import type { ScheduledEvent } from 'aws-lambda';
import pino from 'pino';
import { loadConfig } from '@imgopt/config';
import { S3Storage } from '@imgopt/storage';
import { AssetRepository, createPrismaClient, hydrateDatabaseCredentials } from '@imgopt/db';
import { Maintenance, type MaintenanceReport } from './maintenance.js';

// Same as the other Lambdas: the password is fetched from the secret store during
// init, because a Lambda environment variable is plaintext in the console.
await hydrateDatabaseCredentials();

const config = loadConfig();

const logger = pino({ level: config.logLevel, base: { component: 'maintenance' } });

const storage = new S3Storage({
  bucket: config.storage.bucket,
  region: config.storage.region,
  ...(config.storage.endpoint !== undefined ? { endpoint: config.storage.endpoint } : {}),
  forcePathStyle: config.storage.forcePathStyle,
});

const prisma = createPrismaClient({
  connectionString: config.database.url,
  context: 'lambda',
});

const maintenance = new Maintenance(storage, new AssetRepository(prisma), config, logger);

export async function handler(_event: ScheduledEvent): Promise<MaintenanceReport> {
  return maintenance.run();
}
