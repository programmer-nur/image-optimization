import { describe, expect, it } from 'vitest';
import { CONFORMANCE_VECTORS, EQUIVALENCE_GROUPS } from './conformance-vectors.js';
import { toVariantName } from './canonical-key.js';
import { parseTransformFromQuery } from './transform-spec.js';

function run(query: string, accept?: string): string {
  const result = parseTransformFromQuery(query, accept);
  return result.ok ? toVariantName(result.spec) : `ERROR:${result.error.code}`;
}

describe('conformance vectors', () => {
  it('carries enough vectors to be meaningful', () => {
    expect(CONFORMANCE_VECTORS.length).toBeGreaterThanOrEqual(200);
  });

  it.each(CONFORMANCE_VECTORS.map((v) => [v.query || '(empty)', v] as const))(
    '%s',
    (_label, vector) => {
      expect(run(vector.query, vector.accept)).toBe(vector.expected);
    },
  );
});

describe('equivalence groups', () => {
  it.each(EQUIVALENCE_GROUPS.map((g) => [g.name, g] as const))(
    'collapses onto one key: %s',
    (_name, group) => {
      const keys = new Set(group.queries.map((q) => run(q, group.accept)));

      expect(keys.size, `expected one key, got: ${[...keys].join(', ')}`).toBe(1);
    },
  );
});
