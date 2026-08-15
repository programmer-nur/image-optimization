/**
 * The metric vocabulary.
 *
 * Named constants rather than string literals at each call site, because a metric
 * emitted under a misspelled name does not fail — it creates a second, empty series
 * while the dashboard and the alarm keep watching the first one and reporting
 * health. Every alarm and dashboard widget references these same constants.
 */

import { emit, sizeBucket, type MetricValue } from './emf.js';

export const METRICS = {
  /** One per derivative produced, wherever it was produced. */
  generationCount: 'GenerationCount',
  generationLatency: 'GenerationLatencyMs',
  generationBytes: 'GenerationBytes',
  generationFailures: 'GenerationFailures',
  /**
   * Generations served straight to a viewer on a cache miss.
   *
   * The single most important number in the system. Normalization drift between the
   * edge and the core makes every request regenerate, and that failure produces no
   * errors, no 5xx, and no latency alarm — the images are correct, they are simply
   * being made from scratch every time. This is the only signal. See design.md D4.
   */
  onDemandGenerations: 'OnDemandGenerations',
  /** On-demand generation for a key that already existed: drift, by definition. */
  redundantGenerations: 'RedundantGenerations',

  uploadCount: 'UploadCount',
  uploadRejections: 'UploadRejections',
  uploadBytes: 'UploadBytes',

  /** Bytes leaving the generator, by format. A direct read on the dominant cost. */
  bytesServed: 'BytesServed',

  optimizeJobs: 'OptimizeJobs',
  optimizeFailures: 'OptimizeFailures',
  optimizeLatency: 'OptimizeLatencyMs',

  requestCount: 'RequestCount',
  requestLatency: 'RequestLatencyMs',
  requestErrors: 'RequestErrors',
} as const;

export const DIMENSIONS = {
  format: 'Format',
  sizeBucket: 'SizeBucket',
  reason: 'Reason',
  source: 'Source',
  route: 'Route',
  statusClass: 'StatusClass',
} as const;

export interface GenerationMetric {
  format: string;
  width?: number;
  durationMs: number;
  bytes: number;
  /** Where the derivative came from: the warm set, or a viewer's cache miss. */
  source: 'warm' | 'ondemand';
  /** True when the conditional write lost — the object already existed. */
  redundant?: boolean;
  assetId?: string;
  canonicalKey?: string;
}

/**
 * Records one successful generation.
 *
 * Dimensioned by format and size bucket so an encoder regression shows up as a shift
 * in one series rather than as a barely-perceptible move in an aggregate.
 */
export function recordGeneration(metric: GenerationMetric): void {
  // Annotated, not inferred: without it TypeScript narrows the element type to the
  // three names present at construction and rejects every conditional push below.
  const values: MetricValue[] = [
    { name: METRICS.generationCount, value: 1, unit: 'Count' },
    { name: METRICS.generationLatency, value: metric.durationMs, unit: 'Milliseconds' },
    { name: METRICS.generationBytes, value: metric.bytes, unit: 'Bytes' },
  ];

  if (metric.source === 'ondemand') {
    values.push({ name: METRICS.onDemandGenerations, value: 1, unit: 'Count' });
    values.push({ name: METRICS.bytesServed, value: metric.bytes, unit: 'Bytes' });

    // A conditional write that lost means the object was already there, so this
    // request regenerated something that existed. Rare and harmless once; sustained,
    // it is the signature of edge/core drift.
    if (metric.redundant === true) {
      values.push({ name: METRICS.redundantGenerations, value: 1, unit: 'Count' });
    }
  }

  emit(values, {
    dimensions: {
      [DIMENSIONS.format]: metric.format,
      [DIMENSIONS.sizeBucket]: sizeBucket(metric.width),
      [DIMENSIONS.source]: metric.source,
    },
    // Per-format, per-source, and total. The empty set is what the alarm watches:
    // drift affects every format at once, so a total is the clearest signal.
    dimensionSets: [[DIMENSIONS.format, DIMENSIONS.sizeBucket], [DIMENSIONS.source], []],
    properties: {
      ...(metric.assetId !== undefined ? { assetId: metric.assetId } : {}),
      ...(metric.canonicalKey !== undefined ? { canonicalKey: metric.canonicalKey } : {}),
    },
  });
}

/** Records a generation failure, classified so the graph distinguishes causes. */
export function recordGenerationFailure(
  reason: string,
  context: Record<string, unknown> = {},
): void {
  emit([{ name: METRICS.generationFailures, value: 1, unit: 'Count' }], {
    dimensions: { [DIMENSIONS.reason]: reason },
    dimensionSets: [[DIMENSIONS.reason], []],
    properties: context,
  });
}

/** Records an accepted upload. */
export function recordUpload(bytes: number, format: string): void {
  emit(
    [
      { name: METRICS.uploadCount, value: 1, unit: 'Count' },
      { name: METRICS.uploadBytes, value: bytes, unit: 'Bytes' },
    ],
    {
      dimensions: { [DIMENSIONS.format]: format },
      dimensionSets: [[DIMENSIONS.format], []],
    },
  );
}

/**
 * Records a rejected upload, by reason.
 *
 * The reason dimension is what separates "a consuming application shipped a bug" from
 * "someone is probing the uploader" — the same total, two completely different
 * responses.
 */
export function recordUploadRejection(reason: string, context: Record<string, unknown> = {}): void {
  emit([{ name: METRICS.uploadRejections, value: 1, unit: 'Count' }], {
    dimensions: { [DIMENSIONS.reason]: reason },
    dimensionSets: [[DIMENSIONS.reason], []],
    properties: context,
  });
}

/** Records one optimizer job outcome. */
export function recordOptimizeJob(input: {
  durationMs: number;
  derivatives: number;
  failed?: boolean;
  reason?: string;
}): void {
  const values: MetricValue[] = [
    { name: METRICS.optimizeJobs, value: 1, unit: 'Count' },
    { name: METRICS.optimizeLatency, value: input.durationMs, unit: 'Milliseconds' },
  ];
  if (input.failed === true) {
    values.push({ name: METRICS.optimizeFailures, value: 1, unit: 'Count' });
  }

  emit(values, {
    dimensions: input.reason !== undefined ? { [DIMENSIONS.reason]: input.reason } : {},
    dimensionSets: input.reason !== undefined ? [[DIMENSIONS.reason], []] : [[]],
  });
}

/** Records one control-plane request. */
export function recordRequest(input: { route: string; status: number; durationMs: number }): void {
  const statusClass = `${Math.floor(input.status / 100)}xx`;
  const values: MetricValue[] = [
    { name: METRICS.requestCount, value: 1, unit: 'Count' },
    { name: METRICS.requestLatency, value: input.durationMs, unit: 'Milliseconds' },
  ];
  if (input.status >= 500) {
    values.push({ name: METRICS.requestErrors, value: 1, unit: 'Count' });
  }

  emit(values, {
    dimensions: {
      // The *route pattern*, never the resolved path: `/v1/images/:id` is one series,
      // while the resolved form would be one series per asset ever requested.
      [DIMENSIONS.route]: input.route,
      [DIMENSIONS.statusClass]: statusClass,
    },
    dimensionSets: [[DIMENSIONS.route], [DIMENSIONS.statusClass], []],
  });
}
