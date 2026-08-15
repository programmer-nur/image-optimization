/**
 * Metric emission tests.
 *
 * EMF is a contract with a parser that never reports errors: a malformed `_aws`
 * block, a dimension named in a set but not supplied, or a metric absent from the
 * `Metrics` list all produce a log line CloudWatch silently declines to turn into a
 * metric. The dashboard then shows an empty graph and the alarm sits in
 * INSUFFICIENT_DATA, which reads as "healthy" to anyone glancing at it.
 *
 * These assert the record shape for exactly that reason.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emit, setSink, sizeBucket } from './emf.js';
import {
  DIMENSIONS,
  METRICS,
  recordGeneration,
  recordGenerationFailure,
  recordRequest,
  recordUploadRejection,
} from './metrics.js';

interface EmfRecord {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: string;
      Dimensions: string[][];
      Metrics: Array<{ Name: string; Unit: string }>;
    }>;
  };
  [key: string]: unknown;
}

let lines: string[] = [];
let restore: ReturnType<typeof setSink>;

beforeEach(() => {
  lines = [];
  restore = setSink((line) => lines.push(line));
});

afterEach(() => {
  setSink(restore);
});

const parsed = (): EmfRecord[] => lines.map((line) => JSON.parse(line) as EmfRecord);

describe('record shape', () => {
  it('is valid JSON carrying an _aws block', () => {
    emit([{ name: 'Test', value: 1, unit: 'Count' }], { dimensions: { A: 'x' } });

    const [record] = parsed();
    expect(record?._aws.CloudWatchMetrics[0]?.Namespace).toBe('Imgopt');
    expect(record?._aws.Timestamp).toBeTypeOf('number');
  });

  it('puts every declared metric value at the record root', () => {
    // A metric listed in `Metrics` but absent from the root is dropped silently.
    emit([
      { name: 'Alpha', value: 12, unit: 'Count' },
      { name: 'Beta', value: 34, unit: 'Milliseconds' },
    ]);

    const [record] = parsed();
    expect(record?.['Alpha']).toBe(12);
    expect(record?.['Beta']).toBe(34);
    expect(record?._aws.CloudWatchMetrics[0]?.Metrics).toHaveLength(2);
  });

  it('drops a dimension set naming a value that was not supplied', () => {
    // CloudWatch discards the whole record in that case, taking the other metrics
    // in it with it.
    emit([{ name: 'Test', value: 1, unit: 'Count' }], {
      dimensions: { Present: 'yes' },
      dimensionSets: [['Present'], ['Present', 'Missing'], []],
    });

    const sets = parsed()[0]?._aws.CloudWatchMetrics[0]?.Dimensions;
    expect(sets).toEqual([['Present'], []]);
  });

  it('emits nothing at all for an empty metric list', () => {
    emit([]);
    expect(lines).toHaveLength(0);
  });

  it('carries properties without making them dimensions', () => {
    // The distinction is the bill: a dimension is charged per unique value, and an
    // asset id has unbounded cardinality.
    emit([{ name: 'Test', value: 1, unit: 'Count' }], {
      dimensions: { Format: 'avif' },
      properties: { assetId: 'abc123' },
    });

    const record = parsed()[0]!;
    expect(record['assetId']).toBe('abc123');
    expect(record._aws.CloudWatchMetrics[0]?.Dimensions.flat()).not.toContain('assetId');
  });
});

describe('generation metrics', () => {
  it('dimensions by format and size bucket', () => {
    recordGeneration({
      format: 'avif',
      width: 1080,
      durationMs: 420,
      bytes: 51_200,
      source: 'ondemand',
    });

    const record = parsed()[0]!;
    expect(record[DIMENSIONS.format]).toBe('avif');
    expect(record[DIMENSIONS.sizeBucket]).toBe('medium');
    expect(record[METRICS.generationLatency]).toBe(420);
  });

  it('counts an on-demand generation and the bytes it served', () => {
    recordGeneration({
      format: 'webp',
      width: 640,
      durationMs: 100,
      bytes: 2048,
      source: 'ondemand',
    });

    const record = parsed()[0]!;
    expect(record[METRICS.onDemandGenerations]).toBe(1);
    expect(record[METRICS.bytesServed]).toBe(2048);
  });

  it('does not count warm-set work as on-demand', () => {
    // The warm set runs at upload, behind a queue, with nobody waiting. Counting it
    // here would put a permanent floor under the metric that detects drift.
    recordGeneration({ format: 'avif', width: 1080, durationMs: 100, bytes: 2048, source: 'warm' });

    const record = parsed()[0]!;
    expect(record[METRICS.onDemandGenerations]).toBeUndefined();
    expect(record[METRICS.bytesServed]).toBeUndefined();
    expect(record[METRICS.generationCount]).toBe(1);
  });

  it('flags a generation that found the object already present', () => {
    // Sustained, this is the signature of edge/core normalization drift.
    recordGeneration({
      format: 'avif',
      width: 640,
      durationMs: 90,
      bytes: 1024,
      source: 'ondemand',
      redundant: true,
    });

    expect(parsed()[0]![METRICS.redundantGenerations]).toBe(1);
  });

  it('publishes a total alongside the per-format series', () => {
    // Drift affects every format at once, so the alarm watches the total.
    recordGeneration({
      format: 'avif',
      width: 640,
      durationMs: 90,
      bytes: 1024,
      source: 'ondemand',
    });

    expect(parsed()[0]!._aws.CloudWatchMetrics[0]?.Dimensions).toContainEqual([]);
  });

  it('classifies a failure by reason', () => {
    recordGenerationFailure('corrupt_source', { assetId: 'abc' });

    const record = parsed()[0]!;
    expect(record[DIMENSIONS.reason]).toBe('corrupt_source');
    expect(record[METRICS.generationFailures]).toBe(1);
  });
});

describe('upload rejection metrics', () => {
  it('carries the reason, which is what separates a bug from an attack', () => {
    recordUploadRejection('content_type_mismatch');

    expect(parsed()[0]![DIMENSIONS.reason]).toBe('content_type_mismatch');
  });
});

describe('request metrics', () => {
  it('derives a status class rather than dimensioning on the exact code', () => {
    recordRequest({ route: '/v1/images', status: 503, durationMs: 12 });

    const record = parsed()[0]!;
    expect(record[DIMENSIONS.statusClass]).toBe('5xx');
    expect(record[METRICS.requestErrors]).toBe(1);
  });

  it('counts a 4xx as a request but not as a server error', () => {
    recordRequest({ route: '/v1/images', status: 422, durationMs: 8 });

    const record = parsed()[0]!;
    expect(record[METRICS.requestCount]).toBe(1);
    expect(record[METRICS.requestErrors]).toBeUndefined();
  });
});

describe('sizeBucket', () => {
  it.each([
    [undefined, 'full'],
    [16, 'icon'],
    [256, 'icon'],
    [320, 'small'],
    [828, 'small'],
    [960, 'medium'],
    [1920, 'medium'],
    [2560, 'large'],
    [3840, 'large'],
  ])('maps %s to %s', (width, expected) => {
    expect(sizeBucket(width)).toBe(expected);
  });

  it('collapses twenty ladder rungs into four bands', () => {
    // Twenty dimension values times four formats is eighty series to answer one
    // question that four bands answer as well.
    const buckets = new Set(
      [
        16, 32, 48, 64, 96, 128, 192, 256, 320, 480, 640, 750, 828, 960, 1080, 1200, 1440, 1920,
        2560, 3840,
      ].map((w) => sizeBucket(w)),
    );
    expect(buckets.size).toBe(4);
  });
});
