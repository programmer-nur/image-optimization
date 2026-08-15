/**
 * The queue port.
 *
 * Kept AWS-free for the same reason as the storage port: the API enqueues, the
 * optimizer consumes, and both should be testable against ElasticMQ — or a fake —
 * without importing an SQS client.
 */

/** Payload of an optimization job. Deliberately small: an id, not an image. */
export interface OptimizeJob {
  assetId: string;
  assetVersion: number;
  /** Propagated from the originating request so logs stitch across components. */
  correlationId: string;
  /** Set when re-running the warm set for an asset that already exists. */
  reprocess?: boolean;
}

export interface EnqueueOptions {
  /** Seconds to withhold the message from consumers. */
  delaySeconds?: number;
  /** Deduplication hint; adapters may ignore it on standard queues. */
  deduplicationId?: string;
}

export interface ReceivedMessage<T> {
  body: T;
  receiptHandle: string;
  messageId: string;
  /** Delivery count. A value above one means a prior attempt failed or timed out. */
  receiveCount: number;
}

export interface ReceiveOptions {
  maxMessages?: number;
  /** Long-poll duration. Zero busy-polls and costs more requests. */
  waitTimeSeconds?: number;
  visibilityTimeoutSeconds?: number;
}

export interface QueuePort<T = OptimizeJob> {
  enqueue(job: T, options?: EnqueueOptions): Promise<{ messageId: string }>;
  receive(options?: ReceiveOptions): Promise<ReceivedMessage<T>[]>;
  /** Acknowledges a message so it is not redelivered. */
  acknowledge(receiptHandle: string): Promise<void>;
  /** Returns a message to the queue early, usually to retry sooner. */
  release(receiptHandle: string, delaySeconds?: number): Promise<void>;
  /** Approximate depth, for backlog monitoring. */
  depth(): Promise<{ available: number; inFlight: number }>;
}

export class QueueError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'QueueError';
    this.code = code;
  }
}
