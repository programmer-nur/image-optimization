/**
 * SQS Lambda entry point.
 *
 * `sharp-init` is imported first so libvips concurrency and caching are configured
 * during init, before any image work. The clients below are constructed once at
 * module scope and reused across warm invocations.
 *
 * Failure handling uses SQS partial-batch responses: only messages whose failure is
 * *retriable* are reported back for redelivery. A terminal failure (corrupt source)
 * is recorded on the asset and acknowledged, so it is not retried pointlessly — and
 * after the queue's max receive count, genuinely stuck messages land in the DLQ.
 */

import './sharp-init.js';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import pino from 'pino';
import { loadConfig } from '@imgopt/config';
import { S3Storage } from '@imgopt/storage';
import { AssetRepository, createPrismaClient, hydrateDatabaseCredentials } from '@imgopt/db';
import type { OptimizeJob } from '@imgopt/queue';
import { CORRELATION_ATTRIBUTE } from '@imgopt/queue';
import { Optimizer } from './optimizer.js';

// Resolves the database password from Secrets Manager before configuration is read.
// Runs during init — free time on a managed runtime — and is a no-op locally, where
// the password is already in the environment. A Lambda environment variable is
// plaintext in the console and the template, so the function is given the secret's
// ARN instead of its value.
await hydrateDatabaseCredentials();

const config = loadConfig();

const baseLogger = pino({ level: config.logLevel, base: { component: 'optimizer' } });

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
const repo = new AssetRepository(prisma);

function parseJob(record: SQSRecord): OptimizeJob {
  const job = JSON.parse(record.body) as OptimizeJob;
  if (typeof job.assetId !== 'string' || typeof job.assetVersion !== 'number') {
    throw new Error('malformed optimize job');
  }
  return job;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const correlationId =
      record.messageAttributes?.[CORRELATION_ATTRIBUTE]?.stringValue ?? record.messageId;
    const logger = baseLogger.child({ correlationId });

    let job: OptimizeJob;
    try {
      job = parseJob(record);
    } catch (error) {
      // A malformed message can never succeed; retrying just loops it to the DLQ the
      // slow way. Ack it and move on.
      logger.error({ err: error, messageId: record.messageId }, 'discarding malformed message');
      continue;
    }

    try {
      const optimizer = new Optimizer(
        storage,
        repo,
        config,
        logger.child({ assetId: job.assetId }),
      );
      const outcome = await optimizer.process(job);

      if (outcome.status === 'failed' && outcome.retriable) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    } catch (error) {
      // An unclassified throw escaping process() is treated as retriable.
      logger.error({ err: error, assetId: job.assetId }, 'unhandled optimizer error');
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
