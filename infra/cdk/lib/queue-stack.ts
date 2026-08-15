/**
 * Queue stack — the optimize queue and its dead-letter queue.
 *
 * One queue, no Redis. Duplicate work is suppressed by S3 conditional writes rather
 * than by a distributed lock, and retries and dead-lettering come from SQS itself.
 * See design.md D11.
 */

import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from './config.js';

export interface QueueStackProps extends StackProps {
  config: EnvironmentConfig;
}

export class QueueStack extends Stack {
  readonly optimizeQueue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: QueueStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.deadLetterQueue = new sqs.Queue(this, 'OptimizeDlq', {
      queueName: `imgopt-${config.name}-optimize-dlq`,
      // Long, because a dead-lettered message is evidence. Anything here is a bug to
      // read and replay, not a transient blip to age out over the weekend.
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    this.optimizeQueue = new sqs.Queue(this, 'OptimizeQueue', {
      queueName: `imgopt-${config.name}-optimize`,
      // Must exceed the optimizer's own timeout, or a slow-but-healthy job is
      // redelivered while the first attempt is still running.
      visibilityTimeout: config.queue.visibilityTimeout,
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: config.queue.maxReceiveCount,
      },
    });

    new CfnOutput(this, 'OptimizeQueueUrl', { value: this.optimizeQueue.queueUrl });
    new CfnOutput(this, 'OptimizeDlqUrl', { value: this.deadLetterQueue.queueUrl });
  }
}
