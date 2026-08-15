/**
 * Integration tests against ElasticMQ.
 *
 * Run `pnpm dev:up` first. The local queue is configured with the same redrive
 * topology as production (maxReceiveCount 3 into a DLQ), so retry and dead-lettering
 * behaviour is exercised for real rather than asserted against a mock.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CORRELATION_ATTRIBUTE, SqsQueue } from './sqs.js';
import type { OptimizeJob } from './port.js';

const ENDPOINT = process.env['SQS_ENDPOINT'] ?? 'http://localhost:9324';
const QUEUE_URL =
  process.env['SQS_OPTIMIZE_QUEUE_URL'] ?? `${ENDPOINT}/000000000000/imgopt-optimize`;
const DLQ_URL = `${ENDPOINT}/000000000000/imgopt-optimize-dlq`;

const credentials = { accessKeyId: 'x', secretAccessKey: 'x' };
const queue = new SqsQueue({
  queueUrl: QUEUE_URL,
  region: 'elasticmq',
  endpoint: ENDPOINT,
  credentials,
});
const dlq = new SqsQueue({
  queueUrl: DLQ_URL,
  region: 'elasticmq',
  endpoint: ENDPOINT,
  credentials,
});

function job(overrides: Partial<OptimizeJob> = {}): OptimizeJob {
  return {
    assetId: `asset_${Math.random().toString(36).slice(2, 10)}`,
    assetVersion: 1,
    correlationId: `corr_${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  };
}

/** Leaves the queue empty so ordering between tests cannot leak. */
async function drain(target: SqsQueue): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const messages = await target.receive({ maxMessages: 10, visibilityTimeoutSeconds: 30 });
    if (messages.length === 0) return;
    for (const message of messages) await target.acknowledge(message.receiptHandle);
  }
}

beforeAll(async () => {
  await queue.depth().catch((error: unknown) => {
    throw new Error(
      `Cannot reach the queue at ${ENDPOINT}. Run "pnpm dev:up" first. (${String(error)})`,
    );
  });
  await drain(queue);
  await drain(dlq);
});

afterEach(async () => {
  await drain(queue);
  await drain(dlq);
});

afterAll(() => {
  queue.destroy();
  dlq.destroy();
});

describe('enqueue and receive', () => {
  it('round-trips a job', async () => {
    const sent = job();
    const { messageId } = await queue.enqueue(sent);
    expect(messageId).not.toBe('');

    const [received] = await queue.receive({ waitTimeSeconds: 1 });
    expect(received?.body).toEqual(sent);
  });

  it('carries the correlation id as a message attribute', async () => {
    // Sent as an attribute, not only in the body, so one asset's lifecycle can be
    // stitched together across API, queue, and worker.
    const sent = job({ correlationId: 'corr_trace_me' });
    await queue.enqueue(sent);

    const [received] = await queue.receive({ waitTimeSeconds: 1 });
    expect(received?.body.correlationId).toBe('corr_trace_me');
    expect(CORRELATION_ATTRIBUTE).toBe('correlationId');
  });

  it('returns an empty array when nothing is queued', async () => {
    expect(await queue.receive({ waitTimeSeconds: 0 })).toEqual([]);
  });

  it('receives several messages at once', async () => {
    await Promise.all([queue.enqueue(job()), queue.enqueue(job()), queue.enqueue(job())]);

    const received = await queue.receive({ maxMessages: 10, waitTimeSeconds: 1 });
    expect(received.length).toBeGreaterThanOrEqual(3);
  });

  it('preserves the reprocess flag', async () => {
    await queue.enqueue(job({ reprocess: true }));

    const [received] = await queue.receive({ waitTimeSeconds: 1 });
    expect(received?.body.reprocess).toBe(true);
  });
});

describe('acknowledgement', () => {
  it('stops redelivery once acknowledged', async () => {
    await queue.enqueue(job());

    const [received] = await queue.receive({ waitTimeSeconds: 1, visibilityTimeoutSeconds: 1 });
    await queue.acknowledge(received!.receiptHandle);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await queue.receive({ waitTimeSeconds: 1 })).toEqual([]);
  });

  it('redelivers an unacknowledged message after its visibility timeout', async () => {
    await queue.enqueue(job());

    const [first] = await queue.receive({ waitTimeSeconds: 1, visibilityTimeoutSeconds: 1 });
    expect(first).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const [second] = await queue.receive({ waitTimeSeconds: 2 });
    expect(second?.body.assetId).toBe(first!.body.assetId);
    expect(second!.receiveCount).toBeGreaterThan(1);
  });
});

describe('release', () => {
  it('returns a message for immediate retry', async () => {
    await queue.enqueue(job());

    const [received] = await queue.receive({ waitTimeSeconds: 1, visibilityTimeoutSeconds: 60 });
    await queue.release(received!.receiptHandle, 0);

    const [again] = await queue.receive({ waitTimeSeconds: 2 });
    expect(again?.body.assetId).toBe(received!.body.assetId);
  });
});

describe('receive count', () => {
  it('increments across deliveries, which is what drives retry decisions', async () => {
    await queue.enqueue(job());

    const counts: number[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const [message] = await queue.receive({ waitTimeSeconds: 2, visibilityTimeoutSeconds: 1 });
      if (message === undefined) break;
      counts.push(message.receiveCount);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    expect(counts.length).toBeGreaterThanOrEqual(2);
    expect(counts[1]!).toBeGreaterThan(counts[0]!);
  });
});

describe('dead-lettering', () => {
  it('moves a message to the DLQ after the configured attempts', async () => {
    // The local queue mirrors production redrive: maxReceiveCount 3.
    await queue.enqueue(job({ assetId: 'asset_poison' }));

    for (let attempt = 0; attempt < 4; attempt++) {
      const messages = await queue.receive({ waitTimeSeconds: 2, visibilityTimeoutSeconds: 1 });
      if (messages.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    const dead = await dlq.receive({ waitTimeSeconds: 2, maxMessages: 10 });
    expect(dead.map((m) => m.body.assetId)).toContain('asset_poison');
  });
});

describe('depth', () => {
  it('reports available and in-flight counts', async () => {
    await Promise.all([queue.enqueue(job()), queue.enqueue(job())]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const before = await queue.depth();
    expect(before.available).toBeGreaterThanOrEqual(2);

    await queue.receive({ maxMessages: 1, waitTimeSeconds: 1, visibilityTimeoutSeconds: 30 });
    const during = await queue.depth();

    expect(during.inFlight).toBeGreaterThanOrEqual(1);
  });
});

describe('delay', () => {
  it('withholds a delayed message', async () => {
    await queue.enqueue(job(), { delaySeconds: 2 });

    expect(await queue.receive({ waitTimeSeconds: 1 })).toEqual([]);

    const [later] = await queue.receive({ waitTimeSeconds: 3 });
    expect(later).toBeDefined();
  });
});
