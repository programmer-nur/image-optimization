import { describe, expect, it } from 'vitest';
import { CONFORMANCE_VECTORS, EQUIVALENCE_GROUPS, PATH_VECTORS } from './conformance-vectors.js';
import { parseCanonicalKey, toCanonicalKey, toVariantName } from './canonical-key.js';
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

/*
 * The path vectors, from this side.
 *
 * The edge replays the same list against the generated function; here they pin what
 * `toCanonicalKey` builds and what `parseCanonicalKey` accepts. Two implementations
 * held to one hand-written list is the only thing that makes a path-grammar change
 * impossible to land on one side alone.
 */
describe('path vectors', () => {
  const rewrites = PATH_VECTORS.filter((vector) => vector.expected.startsWith('/derived/'));

  it('covers both viewer prefixes and every storage prefix', () => {
    expect(PATH_VECTORS.some((v) => v.uri.startsWith('/i/'))).toBe(true);
    expect(PATH_VECTORS.some((v) => v.uri.startsWith('/p/'))).toBe(true);
    expect(PATH_VECTORS.filter((v) => v.expected === 'ERROR:unsupported_path')).toHaveLength(4);
  });

  it.each(rewrites.map((v) => [v.uri, v] as const))(
    'core builds and re-parses the key the edge emits for %s',
    (_label, vector) => {
      const parsed = parseCanonicalKey(vector.expected);
      expect(parsed.ok, `the generator must accept ${vector.expected}`).toBe(true);
      if (!parsed.ok) return;

      // Round-trip: what the generator recovered rebuilds the identical key.
      expect(`/${toCanonicalKey(parsed.parts)}`).toBe(vector.expected);

      // And the variant matches what the query alone produces, so the path vectors
      // and the query vectors cannot drift apart from each other either.
      const spec = parseTransformFromQuery(vector.query, 'image/avif');
      expect(spec.ok).toBe(true);
      if (spec.ok) expect(vector.expected.endsWith(toVariantName(spec.spec))).toBe(true);
    },
  );
});
