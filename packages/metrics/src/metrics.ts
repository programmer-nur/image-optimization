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

  /**
   * One per completed maintenance run. A heartbeat, and the only one in the system.
   *
   * Reclamation stopping is otherwise entirely silent: no errors, no 5xx, no failed
   * requests — storage simply grows, and the first evidence is a bill months later.
   * The alarm on this metric is inverted (fires on *absence*), which is why it has
   * to be emitted on success rather than derived from Lambda invocations: an
   * invocation that dies mid-walk still counts as an invocation while reclaiming
   * nothing.
   */
  maintenanceRuns: 'MaintenanceRuns',
  /** Objects reclaimed in a run, so a run that suddenly deletes far more is visible. */
  maintenanceReclaimed: 'MaintenanceReclaimed',

  /**
   * Deployment-wide storage, sampled once per maintenance run.
   *
   * Split by tier rather than totalled because each is driven by a different
   * decision — originals by ingest, masters by the conditional-master threshold,
   * derivatives by the warm set — and one number hides the effect of changing any of
   * them. This is also the only read on the largest slow-moving variable in the cost
   * model, which was previously log-only.
   */
  storedOriginalBytes: 'StoredOriginalBytes',
  storedMasterBytes: 'StoredMasterBytes',
  storedDerivativeBytes: 'StoredDerivativeBytes',
  storedAssetCount: 'StoredAssetCount',
  storedDerivativeCount: 'StoredDerivativeCount',
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

/**
 * Records that a maintenance run completed, and how much it reclaimed.
 *
 * Emitted only on a successful run, because the alarm watching it fires on absence.
 * A run that throws halfway leaves no datapoint, which is exactly the signal wanted:
 * the job is the only thing keeping storage bounded, and it fails without producing
 * a single error anyone sees.
 */
export function recordMaintenanceRun(input: { reclaimed: number; dryRun: boolean }): void {
  emit(
    [
      { name: METRICS.maintenanceRuns, value: 1, unit: 'Count' },
      { name: METRICS.maintenanceReclaimed, value: input.reclaimed, unit: 'Count' },
    ],
    {
      // No dimensions: there is one maintenance job per deployment, and a dry run is
      // still a run that proves the path works. `dryRun` travels as a property so it
      // is visible in the log line without splitting the series an alarm watches.
      dimensionSets: [[]],
      properties: { dryRun: input.dryRun },
    },
  );
}

/**
 * Records deployment-wide storage totals, once per maintenance run.
 *
 * The byte values also travel as string properties. CloudWatch stores metric values
 * as doubles, so a total past 2^53 loses integer precision on the graph; the log line
 * beside it is where the exact number stays available.
 */
export function recordStorageTotals(totals: {
  originalBytes: bigint;
  masterBytes: bigint;
  derivativeBytes: bigint;
  assetCount: number;
  derivativeCount: number;
}): void {
  emit(
    [
      { name: METRICS.storedOriginalBytes, value: Number(totals.originalBytes), unit: 'Bytes' },
      { name: METRICS.storedMasterBytes, value: Number(totals.masterBytes), unit: 'Bytes' },
      { name: METRICS.storedDerivativeBytes, value: Number(totals.derivativeBytes), unit: 'Bytes' },
      { name: METRICS.storedAssetCount, value: totals.assetCount, unit: 'Count' },
      { name: METRICS.storedDerivativeCount, value: totals.derivativeCount, unit: 'Count' },
    ],
    {
      // Deployment-wide gauges. Nothing to slice them by that would not be an
      // unbounded dimension value, which is the one way to make EMF expensive.
      dimensionSets: [[]],
      properties: {
        originalBytesExact: totals.originalBytes.toString(),
        masterBytesExact: totals.masterBytes.toString(),
        derivativeBytesExact: totals.derivativeBytes.toString(),
      },
    },
  );
}
