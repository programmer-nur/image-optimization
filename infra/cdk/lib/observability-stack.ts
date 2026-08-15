/**
 * Observability stack — alarms and the dashboard.
 *
 * Separate from compute so an alarm threshold can be tuned during an incident
 * without redeploying the service the alarm is watching.
 *
 * The alarm set is chosen around one idea: **the failures that matter here are the
 * quiet ones.** A generator that throws shows up in every error metric a default
 * setup already has. A generator that succeeds every single time, because the edge
 * and the core disagree on normalization and nothing is ever a cache hit, shows up
 * in none of them — the images are correct, the status codes are 200, latency is
 * normal, and the only evidence is a bill. `OnDemandGenerations` failing to decay is
 * the alarm this whole stack exists for. See design.md D4 and D17.
 */

import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from './config.js';
// Imported from the emitting package, never re-declared. An alarm watching a
// misspelled metric name sits in INSUFFICIENT_DATA forever, which on a dashboard
// reads as "healthy".
import { DIMENSIONS, METRICS, NAMESPACE } from '@imgopt/metrics';

export interface ObservabilityStackProps extends StackProps {
  config: EnvironmentConfig;
  /** Names, not constructs: this stack must not make compute depend on it. */
  optimizeQueueName: string;
  deadLetterQueueName: string;
  generatorFunctionName: string;
  optimizerFunctionName: string;
  distributionId: string;
  loadBalancerFullName: string;
  targetGroupFullName: string;
}

export class ObservabilityStack extends Stack {
  readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `imgopt-${config.name}-alarms`,
      displayName: `imgopt ${config.name} alarms`,
    });

    const alarms: cloudwatch.Alarm[] = [];
    const alarm = (a: cloudwatch.Alarm): cloudwatch.Alarm => {
      a.addAlarmAction(new actions.SnsAction(this.alarmTopic));
      alarms.push(a);
      return a;
    };

    // ---- the quiet failure ------------------------------------------------

    const onDemand = new cloudwatch.Metric({
      namespace: NAMESPACE,
      metricName: METRICS.onDemandGenerations,
      statistic: 'Sum',
      period: Duration.minutes(15),
    });

    /*
     * On-demand generation that does not decay.
     *
     * Healthy behaviour is a burst when new assets or new variants appear, then a
     * decay toward zero as the bounded variant space fills. A sustained high rate
     * means requests are missing that should be hitting — normalization drift, a
     * broken conditional write, an encoder epoch bumped by accident.
     *
     * Evaluated over a long window with several periods precisely because a short
     * spike is normal. This alarm is meant to catch a plateau, not a launch.
     */
    alarm(
      new cloudwatch.Alarm(this, 'OnDemandGenerationRateAlarm', {
        alarmName: `imgopt-${config.name}-ondemand-generation-elevated`,
        alarmDescription:
          'On-demand generation is not decaying. Most likely cause: the generated ' +
          'CloudFront Function and packages/core disagree on normalization, so every ' +
          'request computes a cache key nothing was ever written to. Nothing else ' +
          'will look wrong. Check the conformance suite in infra/cloudfront.',
        metric: onDemand,
        threshold: config.observability.onDemandGenerationsPer15Min,
        evaluationPeriods: 4,
        datapointsToAlarm: 4,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    /*
     * Regenerating keys that already exist.
     *
     * A stronger signal than the rate above and almost impossible to explain
     * innocently: the generator rendered an object, went to write it, and found it
     * already there. Once is a race between two concurrent first requests. Sustained,
     * it is drift, and there is no other cause.
     */
    alarm(
      new cloudwatch.Alarm(this, 'RedundantGenerationAlarm', {
        alarmName: `imgopt-${config.name}-redundant-generation`,
        alarmDescription:
          'Derivatives are being regenerated for keys that already exist. This is ' +
          'edge/core normalization drift unless a deploy is mid-flight.',
        metric: new cloudwatch.Metric({
          namespace: NAMESPACE,
          metricName: METRICS.redundantGenerations,
          statistic: 'Sum',
          period: Duration.minutes(15),
        }),
        threshold: config.observability.redundantGenerationsPer15Min,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // ---- pipeline health --------------------------------------------------

    const dlqDepth = new cloudwatch.Metric({
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesVisible',
      dimensionsMap: { QueueName: props.deadLetterQueueName },
      statistic: 'Maximum',
      period: Duration.minutes(5),
    });

    alarm(
      new cloudwatch.Alarm(this, 'DeadLetterAlarm', {
        alarmName: `imgopt-${config.name}-dead-letter-depth`,
        // Threshold zero, not a tolerance. The expected steady state is empty, so
        // any message here is a job that failed five times and needs reading.
        alarmDescription: 'A message reached the dead-letter queue. Expected depth is zero.',
        metric: dlqDepth,
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    alarm(
      new cloudwatch.Alarm(this, 'QueueAgeAlarm', {
        alarmName: `imgopt-${config.name}-queue-age`,
        alarmDescription:
          'Oldest optimize message is aging. The worker has stalled or is failing ' +
          'repeatedly; uploads will still succeed but will never become ready.',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/SQS',
          metricName: 'ApproximateAgeOfOldestMessage',
          dimensionsMap: { QueueName: props.optimizeQueueName },
          statistic: 'Maximum',
          period: Duration.minutes(5),
        }),
        threshold: config.observability.queueAgeSeconds,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    /*
     * Generation failure *rate*, not count.
     *
     * A raw count alarms during a traffic spike where the proportion is unchanged,
     * and stays silent at 3am when three of four requests fail. The ratio is what
     * describes the service.
     */
    alarm(
      new cloudwatch.Alarm(this, 'GenerationFailureRateAlarm', {
        alarmName: `imgopt-${config.name}-generation-failure-rate`,
        alarmDescription: 'Generation is failing for a significant share of requests.',
        metric: new cloudwatch.MathExpression({
          expression: '100 * failures / MAX([attempts, 1])',
          usingMetrics: {
            failures: new cloudwatch.Metric({
              namespace: NAMESPACE,
              metricName: METRICS.generationFailures,
              statistic: 'Sum',
              period: Duration.minutes(5),
            }),
            attempts: new cloudwatch.Metric({
              namespace: NAMESPACE,
              metricName: METRICS.generationCount,
              statistic: 'Sum',
              period: Duration.minutes(5),
            }),
          },
          period: Duration.minutes(5),
        }),
        threshold: config.observability.generationFailurePercent,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // ---- delivery health --------------------------------------------------

    const cacheHitRate = new cloudwatch.Metric({
      namespace: 'AWS/CloudFront',
      metricName: 'CacheHitRate',
      // CloudFront publishes only to us-east-1, wherever the distribution serves.
      dimensionsMap: { DistributionId: props.distributionId, Region: 'Global' },
      statistic: 'Average',
      period: Duration.minutes(15),
      region: 'us-east-1',
    });

    alarm(
      new cloudwatch.Alarm(this, 'CacheHitRateAlarm', {
        alarmName: `imgopt-${config.name}-cache-hit-rate`,
        alarmDescription:
          'Cache hit ratio has fallen. Usually cache-key fragmentation — a parameter ' +
          'reaching the cache key that should have been normalized away.',
        metric: cacheHitRate,
        threshold: config.observability.cacheHitRatePercent,
        evaluationPeriods: 4,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        // Missing data here means no traffic, which is not a cache problem.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // ---- control plane ----------------------------------------------------

    alarm(
      new cloudwatch.Alarm(this, 'ApiServerErrorAlarm', {
        alarmName: `imgopt-${config.name}-api-5xx`,
        alarmDescription: 'The control plane is returning server errors.',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/ApplicationELB',
          metricName: 'HTTPCode_Target_5XX_Count',
          dimensionsMap: { LoadBalancer: props.loadBalancerFullName },
          statistic: 'Sum',
          period: Duration.minutes(5),
        }),
        threshold: config.observability.apiServerErrorsPer5Min,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    alarm(
      new cloudwatch.Alarm(this, 'UnhealthyTasksAlarm', {
        alarmName: `imgopt-${config.name}-unhealthy-tasks`,
        alarmDescription:
          'Control-plane tasks are failing their readiness check, so the load ' +
          'balancer is withholding traffic from them.',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/ApplicationELB',
          metricName: 'UnHealthyHostCount',
          dimensionsMap: {
            LoadBalancer: props.loadBalancerFullName,
            TargetGroup: props.targetGroupFullName,
          },
          statistic: 'Maximum',
          period: Duration.minutes(1),
        }),
        threshold: 0,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    this.buildDashboard(props, { onDemand, cacheHitRate, dlqDepth });

    new CfnOutput(this, 'AlarmTopicArn', { value: this.alarmTopic.topicArn });
    new CfnOutput(this, 'AlarmCount', { value: String(alarms.length) });
    new CfnOutput(this, 'DashboardName', { value: `imgopt-${config.name}` });
  }

  /**
   * One view that answers "is the service healthy".
   *
   * Ordered by what an operator checks first during an incident, not by which AWS
   * service publishes it: delivery, then the pipeline behind it, then the cost
   * proxies that explain the bill, then raw volume for context.
   */
  private buildDashboard(
    props: ObservabilityStackProps,
    metrics: {
      onDemand: cloudwatch.Metric;
      cacheHitRate: cloudwatch.Metric;
      dlqDepth: cloudwatch.Metric;
    },
  ): void {
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `imgopt-${props.config.name}`,
      defaultInterval: Duration.hours(12),
    });

    const metric = (metricName: string, statistic = 'Sum'): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: NAMESPACE,
        metricName,
        statistic,
        period: Duration.minutes(5),
      });

    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: [
          `# imgopt — ${props.config.name}`,
          '',
          '**Read this first:** if *On-demand generations* is flat rather than decaying,',
          'the edge normalizer and `packages/core` have diverged. Everything else on this',
          'page will look healthy — the images are correct and the status codes are 200.',
        ].join('\n'),
        width: 24,
        height: 3,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Delivery — cache hit ratio',
        left: [metrics.cacheHitRate],
        leftYAxis: { min: 0, max: 100 },
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Delivery — on-demand generations (should decay)',
        left: [metrics.onDemand, metric(METRICS.redundantGenerations)],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Delivery — bytes served by format',
        left: [
          metric(METRICS.bytesServed).with({
            dimensionsMap: { [DIMENSIONS.format]: 'avif' },
            label: 'avif',
          }),
          metric(METRICS.bytesServed).with({
            dimensionsMap: { [DIMENSIONS.format]: 'webp' },
            label: 'webp',
          }),
          metric(METRICS.bytesServed).with({
            dimensionsMap: { [DIMENSIONS.format]: 'jpeg' },
            label: 'jpeg',
          }),
        ],
        width: 8,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Pipeline — queue depth and age',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/SQS',
            metricName: 'ApproximateNumberOfMessagesVisible',
            dimensionsMap: { QueueName: props.optimizeQueueName },
            statistic: 'Maximum',
            period: Duration.minutes(5),
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/SQS',
            metricName: 'ApproximateAgeOfOldestMessage',
            dimensionsMap: { QueueName: props.optimizeQueueName },
            statistic: 'Maximum',
            period: Duration.minutes(5),
          }),
        ],
        width: 8,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Dead letters (expected: 0)',
        metrics: [metrics.dlqDepth],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Pipeline — generation latency by format (p95)',
        left: [
          metric(METRICS.generationLatency, 'p95').with({
            dimensionsMap: { [DIMENSIONS.format]: 'avif', [DIMENSIONS.sizeBucket]: 'medium' },
            label: 'avif medium',
          }),
          metric(METRICS.generationLatency, 'p95').with({
            dimensionsMap: { [DIMENSIONS.format]: 'webp', [DIMENSIONS.sizeBucket]: 'medium' },
            label: 'webp medium',
          }),
        ],
        width: 8,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Volume — uploads and rejections',
        left: [metric(METRICS.uploadCount), metric(METRICS.uploadRejections)],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Control plane — requests and errors',
        left: [metric(METRICS.requestCount), metric(METRICS.requestErrors)],
        right: [metric(METRICS.requestLatency, 'p95')],
        width: 12,
      }),
    );
  }
}
