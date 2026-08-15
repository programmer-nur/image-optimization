/**
 * SQS adapter. ElasticMQ speaks the same API, so local development uses this same
 * class with an endpoint override.
 */

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  QueueError,
  type EnqueueOptions,
  type OptimizeJob,
  type QueuePort,
  type ReceiveOptions,
  type ReceivedMessage,
} from './port.js';

export interface SqsQueueConfig {
  queueUrl: string;
  region: string;
  /** Set for ElasticMQ; leave undefined in AWS. */
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/**
 * Message attribute carrying the correlation id.
 *
 * Sent as an attribute rather than only inside the body so it survives independently
 * of payload shape — the value that lets one asset's upload, queueing, worker run,
 * and derivative writes be reconstructed as a single sequence across three separate
 * compute environments.
 */
export const CORRELATION_ATTRIBUTE = 'correlationId';

export class SqsQueue implements QueuePort<OptimizeJob> {
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  constructor(config: SqsQueueConfig) {
    this.queueUrl = config.queueUrl;
    this.client = new SQSClient({
      region: config.region,
      ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
      ...(config.credentials !== undefined ? { credentials: config.credentials } : {}),
    });
  }

  destroy(): void {
    this.client.destroy();
  }

  async enqueue(job: OptimizeJob, options: EnqueueOptions = {}): Promise<{ messageId: string }> {
    try {
      const out = await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(job),
          ...(options.delaySeconds !== undefined ? { DelaySeconds: options.delaySeconds } : {}),
          MessageAttributes: {
            [CORRELATION_ATTRIBUTE]: {
              DataType: 'String',
              StringValue: job.correlationId,
            },
          },
        }),
      );
      return { messageId: out.MessageId ?? '' };
    } catch (error) {
      throw new QueueError('enqueue_failed', 'Failed to enqueue optimization job.', {
        cause: error,
      });
    }
  }

  async receive(options: ReceiveOptions = {}): Promise<ReceivedMessage<OptimizeJob>[]> {
    try {
      const out = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: options.maxMessages ?? 1,
          WaitTimeSeconds: options.waitTimeSeconds ?? 0,
          ...(options.visibilityTimeoutSeconds !== undefined
            ? { VisibilityTimeout: options.visibilityTimeoutSeconds }
            : {}),
          MessageAttributeNames: ['All'],
          // Per-message system attributes; `AttributeNames` is the deprecated
          // spelling and rejects this value.
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );

      return (out.Messages ?? []).map((message) => ({
        body: JSON.parse(message.Body ?? '{}') as OptimizeJob,
        receiptHandle: message.ReceiptHandle ?? '',
        messageId: message.MessageId ?? '',
        receiveCount: Number(message.Attributes?.['ApproximateReceiveCount'] ?? '1'),
      }));
    } catch (error) {
      throw new QueueError('receive_failed', 'Failed to receive messages.', { cause: error });
    }
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }),
      );
    } catch (error) {
      throw new QueueError('acknowledge_failed', 'Failed to acknowledge message.', {
        cause: error,
      });
    }
  }

  async release(receiptHandle: string, delaySeconds = 0): Promise<void> {
    try {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: delaySeconds,
        }),
      );
    } catch (error) {
      throw new QueueError('release_failed', 'Failed to release message.', { cause: error });
    }
  }

  async depth(): Promise<{ available: number; inFlight: number }> {
    try {
      const out = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      return {
        available: Number(out.Attributes?.['ApproximateNumberOfMessages'] ?? '0'),
        inFlight: Number(out.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? '0'),
      };
    } catch (error) {
      throw new QueueError('depth_failed', 'Failed to read queue depth.', { cause: error });
    }
  }
}
