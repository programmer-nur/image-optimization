import { describe, expect, it } from 'vitest';
import { parseTransform, parseTransformFromQuery } from './transform-spec.js';

const ACCEPT_AVIF = 'image/avif,image/webp,*/*';

function ok(query: string, accept?: string, source?: { width?: number; hasAlpha?: boolean }) {
  const result = parseTransformFromQuery(query, accept, source);
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.spec;
}

function err(query: string) {
  const result = parseTransformFromQuery(query);
  if (result.ok) throw new Error('expected rejection');
  return result.error;
}

describe('parameter policy', () => {
  it('clamps out-of-range numbers so a slightly wrong URL keeps working', () => {
    expect(ok('w=640&q=250', ACCEPT_AVIF).quality).toBe(95);
    expect(ok('w=640&q=1', ACCEPT_AVIF).quality).toBe(50);
    expect(ok('w=99999', ACCEPT_AVIF).width).toBe(3840);
  });

  it('rejects unknown enum values rather than substituting a default', () => {
    // Silently swapping in a fit mode would deliver a visually wrong image.
    expect(err('fit=squish').code).toBe('invalid_enum');
    expect(err('fit=squish').parameter).toBe('fit');
    expect(err('format=bmp').code).toBe('invalid_enum');
  });

  it('rejects unparseable numbers', () => {
    expect(err('w=abc').code).toBe('invalid_number');
    expect(err('w=-5').code).toBe('invalid_number');
    expect(err('w=1e5').code).toBe('invalid_number');
  });

  it('treats an empty value as absent', () => {
    expect(ok('w=640&q=', ACCEPT_AVIF).quality).toBe(75);
  });

  it('ignores unrecognized parameters', () => {
    expect(ok('w=640&utm_source=x&fbclid=y', ACCEPT_AVIF)).toEqual(ok('w=640', ACCEPT_AVIF));
  });

  it('names absolute pixel crops specifically', () => {
    const error = err('crop=100,200,300,400');
    expect(error.code).toBe('unsupported_crop');
    expect(error.message).toMatch(/named gravity/i);
  });

  it('rejects an unknown gravity as a plain enum error', () => {
    expect(err('crop=nowhere').code).toBe('invalid_enum');
  });
});

describe('format negotiation', () => {
  it('prefers AVIF, then WebP, then a legacy format', () => {
    expect(ok('', 'image/avif,image/webp').format).toBe('avif');
    expect(ok('', 'image/webp,image/*').format).toBe('webp');
    expect(ok('', 'image/*').format).toBe('jpeg');
    expect(ok('').format).toBe('jpeg');
  });

  it('falls back to PNG for legacy clients when the source has alpha', () => {
    expect(ok('', 'image/*', { hasAlpha: true }).format).toBe('png');
    expect(ok('', 'image/*', { hasAlpha: false }).format).toBe('jpeg');
  });

  it('ignores Accept when a format is named explicitly', () => {
    expect(ok('format=jpeg', 'image/avif').format).toBe('jpeg');
  });

  it('applies one perceptual default across formats', () => {
    // Quality is a perceptual scale; the per-codec translation happens in the
    // encoder tables, not here. See quality.ts.
    expect(ok('', 'image/avif').quality).toBe(75);
    expect(ok('', 'image/webp').quality).toBe(75);
    expect(ok('', 'image/*').quality).toBe(75);
  });
});

describe('source-aware parsing', () => {
  it('caps the width when the source width is supplied', () => {
    expect(ok('w=3840', ACCEPT_AVIF, { width: 2000 }).width).toBe(1920);
  });

  it('leaves the width uncapped when the source is unknown', () => {
    // This is the edge normalizer's situation. The generator computes the same key
    // from the same URL, so the two cannot drift; the pipeline caps the pixels.
    expect(ok('w=3840', ACCEPT_AVIF).width).toBe(3840);
  });
});

describe('record-based entry point', () => {
  it('accepts a plain record as well as a query string', () => {
    const fromRecord = parseTransform({ w: '640', q: '75' }, ACCEPT_AVIF);
    const fromQuery = parseTransformFromQuery('w=640&q=75', ACCEPT_AVIF);

    expect(fromRecord).toEqual(fromQuery);
  });

  it('tolerates undefined values in the record', () => {
    const result = parseTransform({ w: '640', h: undefined }, ACCEPT_AVIF);
    expect(result.ok).toBe(true);
  });
});

describe('normalization is idempotent', () => {
  it('re-parsing a spec-derived query yields the same spec', () => {
    const first = ok('w=602&h=339&q=82&dpr=1', ACCEPT_AVIF);
    const rebuilt = ok(
      `w=${first.width}&h=${first.height}&q=${first.quality}&fit=${first.fit}`,
      ACCEPT_AVIF,
    );

    expect(rebuilt).toEqual(first);
  });
});
