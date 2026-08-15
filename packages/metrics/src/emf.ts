/**
 * CloudWatch Embedded Metric Format.
 *
 * A metric is emitted by writing one JSON line to stdout. CloudWatch Logs extracts
 * the values and creates the metrics asynchronously, which buys three things that
 * matter here:
 *
 * - **No API call.** `PutMetricData` is a network round trip on the request path.
 *   In the generator that would add latency to the one request a viewer is actually
 *   waiting on, and in Lambda it would keep the invocation alive until it completes.
 * - **No IAM beyond logging.** Every component already writes logs.
 * - **Dimensions and context in one record.** The log line that carries the metric
 *   also carries the asset id and correlation id, so a spike in a graph leads
 *   directly to the individual events behind it rather than to a separate search.
 *
 * The trade is that metrics appear within a minute or so rather than instantly, and
 * that high-cardinality dimensions are expensive — hence the deliberate absence of
 * `assetId` as a dimension anywhere below. It travels as a *property*, which is
 * searchable but not charged per unique value.
 */

export const NAMESPACE = 'Imgopt';

export type Unit = 'Count' | 'Milliseconds' | 'Seconds' | 'Bytes' | 'Percent' | 'None';

export interface MetricValue {
  name: string;
  value: number;
  unit: Unit;
}

export interface EmitOptions {
  /**
   * Dimension sets. Each entry becomes its own aggregation in CloudWatch, so
   * `[['Format'], []]` publishes both a per-format series and a total.
   *
   * Kept small on purpose: CloudWatch charges per unique dimension *combination*,
   * so a dimension with unbounded values — an asset id, a canonical key — turns a
   * cheap metric into an unbounded bill.
   */
  dimensionSets?: string[][];
  /** Dimension values. Every name in `dimensionSets` must appear here. */
  dimensions?: Record<string, string>;
  /** Searchable context that is not a dimension: asset ids, keys, error detail. */
  properties?: Record<string, unknown>;
  namespace?: string;
}

/** Where the line goes. Swapped in tests; stdout everywhere else. */
export type Sink = (line: string) => void;

let sink: Sink = (line) => process.stdout.write(`${line}\n`);

/** Test seam. Returns the previous sink so a test can restore it. */
export function setSink(next: Sink): Sink {
  const previous = sink;
  sink = next;
  return previous;
}

/**
 * Emits one EMF record carrying one or more metrics.
 *
 * Several metrics share a record when they describe the same event — a generation
 * has a latency *and* a byte count *and* a count of one — so the graph and the
 * context stay attached to each other.
 */
export function emit(metrics: MetricValue[], options: EmitOptions = {}): void {
  if (metrics.length === 0) return;

  const dimensions = options.dimensions ?? {};
  // A dimension set naming a value that was not supplied produces a record
  // CloudWatch silently drops, so unusable sets are filtered rather than emitted.
  const dimensionSets = (options.dimensionSets ?? [Object.keys(dimensions)]).filter((set) =>
    set.every((name) => dimensions[name] !== undefined),
  );

  const record: Record<string, unknown> = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: options.namespace ?? NAMESPACE,
          Dimensions: dimensionSets,
          Metrics: metrics.map(({ name, unit }) => ({ Name: name, Unit: unit })),
        },
      ],
    },
    ...dimensions,
    ...options.properties,
  };

  for (const { name, value } of metrics) record[name] = value;

  sink(JSON.stringify(record));
}

/**
 * Buckets a width for use as a dimension.
 *
 * Widths are already confined to the ladder, but twenty dimension values per metric
 * multiplied by four formats is eighty series where four coarse bands answer every
 * question anyone actually asks of this graph — "are large renditions slow?" — at a
 * fifth of the cost.
 */
export function sizeBucket(width: number | undefined): string {
  if (width === undefined) return 'full';
  if (width <= 256) return 'icon';
  if (width <= 828) return 'small';
  if (width <= 1920) return 'medium';
  return 'large';
}
