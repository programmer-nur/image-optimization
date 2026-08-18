/**
 * The conformance runner (tasks 8.4 / 8.5).
 *
 * Replays the shared vectors from `@imgopt/core` against the *generated* CloudFront
 * Function and asserts it produces the same canonical key the library does. This is
 * the structural defense against the highest-severity failure mode in the system:
 * if the edge and core ever disagree on normalization, CloudFront caches key A while
 * the generator writes object B, and the result is a permanent 100% cache miss on
 * that variant — every request invoking Lambda, forever, with nothing whatsoever
 * appearing in error rates. See design.md D4.
 *
 * The function is loaded the way CloudFront loads it: as a bare script with no
 * module system, evaluated for its global `handler`. That also proves the generated
 * file has not accidentally acquired an `import` or `export`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CONFORMANCE_VECTORS,
  EQUIVALENCE_GROUPS,
  PATH_VECTORS,
} from '@imgopt/core/conformance-vectors';
import { parseTransformFromQuery, parseVariantName, toVariantName } from '@imgopt/core';

import { OUTPUT_PATH, generate } from './generate.mjs';

const ASSET_ID = 'abc123';
const VERSION = 'v3-1';

const generatedSource = readFileSync(OUTPUT_PATH, 'utf8');

/** Evaluates the generated file in isolation and hands back its `handler`. */
function loadEdgeHandler(source) {
  return new Function(`${source}\nreturn handler;`)();
}

const handler = loadEdgeHandler(generatedSource);

/**
 * Builds the event shape CloudFront passes to a viewer-request function.
 *
 * Query values arrive URL-decoded, which is why the vector for a percent-encoded
 * `#` in `background` is decoded here rather than passed through raw.
 */
function eventFor(query, accept, { uri = `/i/${ASSET_ID}/${VERSION}/photo.jpg` } = {}) {
  const querystring = {};
  for (const [key, value] of new URLSearchParams(query)) {
    querystring[key] = { value };
  }

  const headers = accept === undefined ? {} : { accept: { value: accept } };
  return { request: { method: 'GET', uri, querystring, headers, cookies: {} } };
}

/** Runs the edge function and reduces its result to the same string the vectors use. */
function runEdge(query, accept, options) {
  const result = handler(eventFor(query, accept, options));

  if (result.statusCode !== undefined) {
    return `ERROR:${result.headers['x-imgopt-error'].value}`;
  }
  return result.uri.slice(result.uri.lastIndexOf('/') + 1);
}

/** The library's answer for the same input. */
function runCore(query, accept) {
  const result = parseTransformFromQuery(query, accept);
  return result.ok ? toVariantName(result.spec) : `ERROR:${result.error.code}`;
}

describe('generated edge function', () => {
  it('is committed in sync with the template and core', () => {
    // Regenerating in memory must reproduce the committed bytes. Without this, a
    // change to the ladder passes every other test in the repo while the deployed
    // edge function keeps bucketing to the old one.
    expect(generate().source).toBe(generatedSource);
  });

  it('fits inside the CloudFront Function source limit', () => {
    expect(Buffer.byteLength(generatedSource, 'utf8')).toBeLessThanOrEqual(10 * 1024);
  });

  it('is a bare script, loadable without a module system', () => {
    expect(generatedSource).not.toMatch(/^\s*(import|export)\s/m);
    expect(typeof handler).toBe('function');
  });
});

describe('edge/core conformance', () => {
  it.each(CONFORMANCE_VECTORS.map((v) => [v.query || '(empty)', v]))('%s', (_label, vector) => {
    const edge = runEdge(vector.query, vector.accept);

    // Asserted against the hand-written expectation *and* against core, so the
    // vectors stay an oracle rather than a mirror of whatever the code does.
    expect(edge).toBe(vector.expected);
    expect(edge).toBe(runCore(vector.query, vector.accept));

    /*
     * The composition: a key the edge emits must be a key the generator accepts.
     *
     * Agreeing on the key is not enough on its own now that `parseVariantName`
     * enforces the ladder and the ratio grid. If those checks were ever stricter
     * than the normalizer is, the two would still agree — and the resulting URL
     * would 400 forever, for exactly the shapes nobody types by hand. Asserted for
     * every vector at once rather than trusted.
     */
    if (!edge.startsWith('ERROR:')) {
      expect(parseVariantName(edge).ok, `generator rejects an edge-emitted key: ${edge}`).toBe(
        true,
      );
    }
  });
});

/*
 * The path half of the grammar, which the query vectors do not reach.
 *
 * They pin the variant filename; this pins the whole rewritten URI — which prefixes
 * are viewer-facing, where the id and version sit, and what is refused outright. That
 * is the part of the edge most likely to change structurally, and until these vectors
 * existed it was covered only by assertions written here, with no shared oracle for
 * `packages/core` to be held to.
 */
describe('edge path shape', () => {
  it.each(PATH_VECTORS.map((v) => [v.uri, v]))('%s', (_label, vector) => {
    const result = handler(eventFor(vector.query, undefined, { uri: vector.uri }));

    const actual =
      result.statusCode === undefined
        ? result.uri
        : `ERROR:${result.headers['x-imgopt-error'].value}`;

    expect(actual).toBe(vector.expected);
  });
});

describe('edge equivalence groups', () => {
  it.each(EQUIVALENCE_GROUPS.map((g) => [g.name, g]))('collapses onto one key: %s', (_name, g) => {
    const keys = new Set(g.queries.map((q) => runEdge(q, g.accept)));

    expect(keys.size, `expected one key, got: ${[...keys].join(', ')}`).toBe(1);
  });
});

describe('URI rewriting', () => {
  it('rewrites to the canonical derivative path and drops the query string', () => {
    const result = handler(eventFor('w=602&q=82&dpr=2&format=auto', 'image/avif,image/webp,*/*'));

    expect(result.uri).toBe(`/derived/${ASSET_ID}/${VERSION}/w1440_q85.avif`);
    expect(result.querystring).toEqual({});
  });

  it('ignores the slug entirely', () => {
    const withSlug = runEdge('w=640', undefined, { uri: `/i/${ASSET_ID}/${VERSION}/red-shoes` });
    const otherSlug = runEdge('w=640', undefined, {
      uri: `/i/${ASSET_ID}/${VERSION}/chaussures-rouges`,
    });
    const noSlug = runEdge('w=640', undefined, { uri: `/i/${ASSET_ID}/${VERSION}` });

    expect(withSlug).toBe(otherSlug);
    expect(withSlug).toBe(noSlug);
  });

  it('ignores unknown parameters rather than letting them reach the cache key', () => {
    expect(runEdge('w=640&utm_source=x&fbclid=y')).toBe(runEdge('w=640'));
  });

  it('passes through a path outside the delivery prefix', () => {
    const event = eventFor('w=640', undefined, { uri: '/healthz' });
    expect(handler(event).uri).toBe('/healthz');
  });

  /*
   * Signed delivery, end to end.
   *
   * `/p/*` is the same delivery behind a cache behavior with a trusted key group, so
   * CloudFront has already refused the request if the signature was missing or wrong.
   * What it must NOT do is skip normalization: an unnormalized `/p/` path 403s at S3,
   * fails over to the generator, and 400s there — a correctly signed URL that has
   * never once returned an image.
   */
  it('normalizes the signature-required prefix into the same key space', () => {
    const priv = handler(
      eventFor('w=602', 'image/avif', { uri: `/p/${ASSET_ID}/${VERSION}/x.jpg` }),
    );
    const pub = handler(
      eventFor('w=602', 'image/avif', { uri: `/i/${ASSET_ID}/${VERSION}/x.jpg` }),
    );

    expect(priv.uri).toBe(`/derived/${ASSET_ID}/${VERSION}/w640_q75.avif`);
    expect(priv.uri).toBe(pub.uri);
    expect(priv.querystring).toEqual({});
  });

  it('applies the same rejections under the private prefix', () => {
    const result = handler(
      eventFor('w=abc', undefined, { uri: `/p/${ASSET_ID}/${VERSION}/x.jpg` }),
    );
    expect(result.statusCode).toBe(400);
  });

  /*
   * The bypass that made bucketing optional.
   *
   * The default behavior routes every path to the S3-then-generator origin group, so
   * before this check a client could skip the normalizer entirely and name a raw
   * storage key — `w641`, `w642`, … — each one a Sharp invocation, a permanent
   * object, and a permanent cache entry. The asset id, version, and epoch are all
   * visible in ordinary public URLs, so nothing had to be guessed.
   */
  it.each([
    '/derived/abc123/v1-1/w641_q75.avif',
    '/derived/abc123/v1-1/w640_q75.avif',
    '/original/abc123/1/source.png',
    '/master/abc123/1/master.webp',
    '/staging/some-upload-id',
  ])('refuses the raw storage path %s', (uri) => {
    const result = handler(eventFor('', undefined, { uri }));

    expect(result.statusCode).toBe(400);
    expect(result.headers['x-imgopt-error'].value).toBe('unsupported_path');
    expect(result.headers['cache-control'].value).toBe('public, max-age=60');
  });

  it.each([
    ['/i/../v1-1/photo.jpg', 'traversal in the asset id'],
    ['/i/abc/3-1/photo.jpg', 'a version segment without its prefix'],
    ['/i/abc/vx/photo.jpg', 'an unparseable version segment'],
  ])('rejects %s (%s)', (uri) => {
    const result = handler(eventFor('w=640', undefined, { uri }));
    expect(result.statusCode).toBe(400);
  });
});

describe('edge rejections', () => {
  it('returns a short-lived client error without reaching an origin', () => {
    const result = handler(eventFor('fit=squish', undefined));

    expect(result.statusCode).toBe(400);
    expect(result.headers['cache-control'].value).toBe('public, max-age=60');
    expect(result.uri).toBeUndefined();
  });

  it('names the offending parameter in the body', () => {
    const result = handler(eventFor('w=abc', undefined));
    expect(JSON.parse(result.body)).toEqual({
      error: { code: 'invalid_number', parameter: 'w' },
    });
  });

  it('rejects an absolute pixel crop distinctly from an unknown gravity', () => {
    expect(runEdge('w=640&crop=10,20,30,40')).toBe('ERROR:unsupported_crop');
    expect(runEdge('w=640&crop=nowhere')).toBe('ERROR:invalid_enum');
  });
});
