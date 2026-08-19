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
import { loadConfig, requireWorkerCallbackUrl, requireWorkerSecret } from '@imgopt/config';
import { S3Storage } from '@imgopt/storage';
import type { OptimizeJob } from '@imgopt/queue';
import { CORRELATION_ATTRIBUTE } from '@imgopt/queue';
import { HttpRegistry } from './http-registry.js';
import { Optimizer } from './optimizer.js';

/*
 * No database connection, and none to resolve.
 *
 * This function used to fetch an RDS password from Secrets Manager during init and
 * open its own Postgres connection, which is the only reason it had to run inside a
 * VPC — and the VPC is what a NAT gateway and six interface endpoints existed to
 * serve. It records its results through the control plane instead (design.md L1/L2).
 */
const config = loadConfig();

const baseLogger = pino({ level: config.logLevel, base: { component: 'optimizer' } });

const storage = new S3Storage({
  bucket: config.storage.bucket,
  region: config.storage.region,
  ...(config.storage.endpoint !== undefined ? { endpoint: config.storage.endpoint } : {}),
  forcePathStyle: config.storage.forcePathStyle,
});

const registry = new HttpRegistry({
  baseUrl: requireWorkerCallbackUrl(config, 'The optimizer'),
  secret: requireWorkerSecret(config, 'The optimizer'),
  timeoutMs: config.worker.callbackTimeoutMs,
});

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
        registry,
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
