import { describe, expect, it } from 'vitest';
import { LADDER } from './breakpoints.js';
import {
  parseCanonicalKey,
  parseVariantName,
  parseVersionSegment,
  toCanonicalKey,
  toDerivedPrefix,
  toMasterKey,
  toOriginalKey,
  toStagingKey,
  toVariantName,
  toVersionSegment,
} from './canonical-key.js';
import { parseTransformFromQuery } from './transform-spec.js';

const ACCEPT_AVIF = 'image/avif,image/webp,*/*';

function keyFor(query: string, accept = ACCEPT_AVIF): string {
  const result = parseTransformFromQuery(query, accept);
  if (!result.ok) throw new Error(`unexpected rejection: ${result.error.message}`);
  return toVariantName(result.spec);
}

describe('bounded variant space', () => {
  it('collapses every integer width 1-4000 onto at most one key per ladder rung', () => {
    const keys = new Set<string>();
    for (let width = 1; width <= 4000; width++) {
      keys.add(keyFor(`w=${width}`));
    }

    // 4000 distinct requests, at most 20 distinct objects. This bound is the
    // property the whole cost model rests on: without it, storage, cache-key
    // space, and Lambda invocations all scale with request variety.
    expect(keys.size).toBeLessThanOrEqual(LADDER.length);
    expect(keys.size).toBe(20);
  });

  it('stays bounded when dpr is varied alongside width', () => {
    const keys = new Set<string>();
    for (let width = 1; width <= 2000; width++) {
      for (const dpr of [1, 2, 3]) {
        keys.add(keyFor(`w=${width}&dpr=${dpr}`));
      }
    }

    expect(keys.size).toBeLessThanOrEqual(LADDER.length);
  });

  it('stays bounded when quality is swept', () => {
    const keys = new Set<string>();
    for (let quality = 0; quality <= 100; quality++) {
      keys.add(keyFor(`w=640&q=${quality}`));
    }

    // Five quality levels, whatever the caller asks for.
    expect(keys.size).toBe(5);
  });

  it('stays bounded when heights are swept against a fixed width', () => {
    const keys = new Set<string>();
    for (let height = 1; height <= 2000; height++) {
      keys.add(keyFor(`w=640&h=${height}`));
    }

    // A synthetic sweep of every integer height mostly lands outside the listed
    // ratios and falls through to 2-decimal quantization, so the bound here is set
    // by that fallback: ratios span 0.05..3.125, giving ~308 buckets plus the 9
    // listed shapes. Finite and independent of request volume, which is the
    // property that matters — but note this is a wider axis than the "~10 ratios"
    // figure in design.md D3, which describes realistic traffic rather than a sweep.
    expect(keys.size).toBeLessThan(350);
  });

  it('collapses hard for realistic ratio traffic', () => {
    // What clients actually request: standard shapes, with a pixel or two of
    // rounding jitter from layout maths.
    const keys = new Set<string>();
    for (const [w, h] of [
      [640, 360],
      [640, 361],
      [640, 359],
      [640, 480],
      [640, 481],
      [640, 427],
      [640, 426],
      [640, 640],
      [640, 639],
    ] as const) {
      keys.add(keyFor(`w=${w}&h=${h}`));
    }

    // 16:9, 4:3, 3:2, and 1:1 — jitter absorbed by the tolerance.
    expect(keys.size).toBe(4);
  });
});

describe('toVariantName', () => {
  it('omits inert components', () => {
    expect(keyFor('w=640')).toBe('w640_q75.avif');
    expect(keyFor('h=480')).toBe('h480_q75.avif');
    expect(keyFor('')).toBe('full_q75.avif');
  });

  it('includes fit only when both dimensions are constrained', () => {
    expect(keyFor('w=640&h=360')).toBe('w640_h360_cover_q75.avif');
    expect(keyFor('w=640&fit=contain')).toBe('w640_q75.avif');
  });

  it('spells rare parameters out in a fixed order', () => {
    expect(keyFor('w=640&blur=5')).toBe('w640_q75_bl5.avif');
    expect(keyFor('w=640&sharpen=1')).toBe('w640_q75_sh1.avif');
    expect(keyFor('w=640&blur=10&sharpen=2')).toBe('w640_q75_bl10_sh2.avif');
    expect(keyFor('w=640&h=360&fit=pad&background=ff0000')).toBe(
      'w640_h360_contain_q75_bgff0000.avif',
    );
    expect(keyFor('w=640&h=360&fit=cover&crop=attention')).toBe(
      'w640_h360_cover_q75_gattention.avif',
    );
  });

  it('distinguishes different rare parameters', () => {
    expect(keyFor('w=640&blur=5')).not.toBe(keyFor('w=640&blur=10'));
    expect(keyFor('w=640&blur=5')).not.toBe(keyFor('w=640&sharpen=1'));
  });

  it('keeps the filename bounded at the worst-case combination', () => {
    const worst = keyFor(
      'w=3840&h=2160&fit=contain&background=ffaa0080&blur=40&sharpen=2&crop=attention',
    );
    // Every component is quantized, so there is a longest possible name and this
    // is it. Bounded length is what made hashing the tail unnecessary.
    expect(worst.length).toBeLessThan(64);
  });

  it('is deterministic across repeated construction', () => {
    const once = keyFor('w=640&h=360&fit=pad&background=ff0000&blur=5');
    const twice = keyFor('w=640&h=360&fit=pad&background=ff0000&blur=5');
    expect(once).toBe(twice);
  });
});

describe('parseVariantName', () => {
  const specFor = (query: string) => {
    const result = parseTransformFromQuery(query, ACCEPT_AVIF);
    if (!result.ok) throw new Error(`unexpected rejection: ${result.error.message}`);
    return result.spec;
  };

  it('round-trips every spec the parser can produce', () => {
    // The generator reconstructs its work from the key alone. If any spec fails to
    // survive this round trip, requests for that variant 502 forever.
    for (const query of [
      '',
      'w=640',
      'h=480',
      'w=640&h=360',
      'w=640&h=360&fit=contain',
      'w=640&h=360&fit=pad&background=ffaa0080',
      'w=640&h=360&fit=cover&crop=top',
      'w=640&h=360&fit=outside&crop=entropy',
      'w=640&blur=5',
      'w=640&sharpen=2',
      'w=640&h=360&fit=pad&background=ff0000&blur=20&sharpen=1',
      'w=640&format=jpeg',
      'w=640&format=png&q=95',
      'w=16&format=webp&q=50',
    ]) {
      const spec = specFor(query);
      const parsed = parseVariantName(toVariantName(spec));

      expect(parsed.ok, `failed to parse key for "${query}"`).toBe(true);
      if (parsed.ok) expect(parsed.spec).toEqual(spec);
    }
  });

  /*
   * The bound that the whole cost model rests on.
   *
   * `{id, version, epoch}` are visible in every public URL, so a derivative path can
   * be constructed by anyone. Accepting an arbitrary width here would let a sweep of
   * `w641, w642, …` mint one Sharp invocation, one permanent object, and one
   * permanent cache entry apiece — bucketing holding only for viewers who happened to
   * arrive through the edge.
   */
  it('rejects a width that is not a ladder rung', () => {
    for (const name of ['w12_q75.avif', 'w641_q75.avif', 'w3839_q75.avif', 'w100000_q75.avif']) {
      expect(parseVariantName(name), name).toEqual({
        ok: false,
        reason: 'malformed_variant',
      });
    }
  });

  it('accepts every ladder rung as a width, and as a lone height', () => {
    for (const rung of LADDER) {
      expect(parseVariantName(`w${rung}_q75.avif`).ok, `w${rung}`).toBe(true);
      expect(parseVariantName(`h${rung}_q75.avif`).ok, `h${rung}`).toBe(true);
    }
  });

  it('rejects a height the ratio quantizer could not have produced', () => {
    // 640 x 360 is 16:9 and legal; 361 is not a value `Math.round(640 * ratio)` can
    // return for any quantized ratio, so it can only have been hand-written.
    expect(parseVariantName('w640_h360_cover_q75.avif').ok).toBe(true);
    expect(parseVariantName('w640_h361_cover_q75.avif').ok).toBe(false);
    expect(parseVariantName('w640_h13000_cover_q75.avif').ok).toBe(false);
  });

  /*
   * The other half of that bound, and the half that is easy to get wrong: the check
   * must accept *everything* the normalizer emits. A height wrongly refused here is a
   * viewer URL that 400s forever, and only for the aspect ratios nobody tests by hand.
   */
  it('accepts every height the normalizer can emit', () => {
    for (const width of LADDER) {
      for (let requested = 1; requested <= width * 4; requested += 7) {
        const spec = specFor(`w=${width}&h=${requested}`);
        const name = toVariantName(spec);

        expect(parseVariantName(name).ok, `${width}x${requested} -> ${name}`).toBe(true);
      }
    }
  });

  it.each([
    ['w640_q75', 'no extension'],
    ['w640_q75.gif', 'unsupported extension'],
    ['w640.avif', 'no quality'],
    ['w640_q70.avif', 'quality off the level set'],
    ['w640_q75_bl3.avif', 'blur off the level set'],
    ['w640_q75_sh9.avif', 'sharpen off the level set'],
    ['w640_q75_gnowhere.avif', 'unknown gravity'],
    ['w640_h360_pad_q75_bgxyz.avif', 'malformed hex'],
    ['w0640_q75.avif', 'leading zero'],
    ['q75_w640.avif', 'tokens out of order'],
    ['w640_q75_bl5_bl5.avif', 'duplicated token'],
    ['w640_q75_squish.avif', 'unknown token'],
    ['w640_cover_q75.avif', 'fit without both dimensions'],
    ['w640_h360_q75.avif', 'both dimensions without a fit'],
    ['w640_q75_bl0.avif', 'inert zero-level blur'],
    ['w640_h360_cover_q75_gcenter.avif', 'inert default gravity'],
    ['w640_h360_cover_q75_bgff0000.avif', 'background on a fit that never pads'],
    ['w640_h360_pad_q75_gtop.avif', 'gravity on a fit that never crops'],
  ])('rejects %s (%s)', (name) => {
    expect(parseVariantName(name).ok).toBe(false);
  });
});

describe('parseCanonicalKey', () => {
  it('inverts toCanonicalKey', () => {
    const spec = parseTransformFromQuery('w=640&h=360&fit=pad&background=ff0000', ACCEPT_AVIF);
    if (!spec.ok) throw new Error('fixture failed to parse');

    const parts = { assetId: 'abc123', assetVersion: 3, encoderEpoch: 2, spec: spec.spec };
    const parsed = parseCanonicalKey(toCanonicalKey(parts));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.parts).toEqual(parts);
  });

  it('accepts the leading slash a rewritten CloudFront URI carries', () => {
    expect(parseCanonicalKey('/derived/abc/v1-1/w640_q75.avif').ok).toBe(true);
  });

  it.each([
    ['original/abc/v1-1/source.jpg', 'a non-derivative prefix'],
    ['derived/abc/v1-1/nested/w640_q75.avif', 'an extra path segment'],
    ['derived/abc/v1-1', 'a missing variant'],
    ['derived//v1-1/w640_q75.avif', 'an empty asset id'],
    ['derived/abc/v1/w640_q75.avif', 'a version without an epoch'],
    ['derived/abc/3-1/w640_q75.avif', 'a version without its prefix'],
  ])('rejects %s (%s)', (key) => {
    expect(parseCanonicalKey(key).ok).toBe(false);
  });

  it('refuses to resolve a traversal toward the originals prefix', () => {
    expect(parseCanonicalKey('derived/../original/abc/1/source.jpg').ok).toBe(false);
  });
});

describe('parseVersionSegment', () => {
  it('separates asset version from encoder epoch', () => {
    expect(parseVersionSegment('v3-2')).toEqual({ assetVersion: 3, encoderEpoch: 2 });
  });

  it('rejects anything else', () => {
    for (const segment of ['v3', '3-2', 'v3-', 'v-2', 'vx-1', 'v3-2-1']) {
      expect(parseVersionSegment(segment)).toBeUndefined();
    }
  });
});

describe('key layout', () => {
  const spec = parseTransformFromQuery('w=640&h=360', ACCEPT_AVIF);
  if (!spec.ok) throw new Error('fixture failed to parse');

  it('places derivatives under a version-scoped prefix', () => {
    expect(
      toCanonicalKey({ assetId: 'abc', assetVersion: 3, encoderEpoch: 1, spec: spec.spec }),
    ).toBe('derived/abc/v3-1/w640_h360_cover_q75.avif');
  });

  it('separates asset version from encoder epoch', () => {
    expect(toVersionSegment(3, 1)).toBe('v3-1');
    expect(toVersionSegment(3, 2)).toBe('v3-2');
  });

  it('mints a whole new URL space from configuration alone, with no per-asset write', () => {
    /*
     * The property that makes `Cache-Control: immutable` safe to promise.
     *
     * Bumping the epoch has to change every asset's URLs at once. If it required a
     * write per asset, changing encoder policy on a million-asset deployment would
     * be a migration rather than a config change — and nobody would ever do it, so
     * the encoder settings would be frozen forever. See design.md D8.
     *
     * `toCanonicalKey` is a pure function of (assetId, version, epoch, spec): the
     * epoch is an argument, never a stored field. This asserts exactly that.
     */
    const assets = ['a1', 'b2', 'c3', 'd4'];

    const before = assets.map((assetId) =>
      toCanonicalKey({ assetId, assetVersion: 1, encoderEpoch: 1, spec: spec.spec }),
    );
    const after = assets.map((assetId) =>
      toCanonicalKey({ assetId, assetVersion: 1, encoderEpoch: 2, spec: spec.spec }),
    );

    // Every asset moved, from one changed argument.
    expect(new Set([...before, ...after]).size).toBe(assets.length * 2);
    for (const [index, key] of before.entries()) expect(after[index]).not.toBe(key);

    // The asset version is untouched — old URLs keep resolving to old objects until
    // lifecycle reclaims them, so in-flight HTML does not break.
    expect(before.every((key) => key.includes('/v1-1/'))).toBe(true);
    expect(after.every((key) => key.includes('/v1-2/'))).toBe(true);
  });

  it('mints a distinct key space when the encoder epoch advances', () => {
    const v1 = toCanonicalKey({
      assetId: 'abc',
      assetVersion: 3,
      encoderEpoch: 1,
      spec: spec.spec,
    });
    const v2 = toCanonicalKey({
      assetId: 'abc',
      assetVersion: 3,
      encoderEpoch: 2,
      spec: spec.spec,
    });
    expect(v1).not.toBe(v2);
  });

  it('keeps originals, masters, and staging on separate prefixes', () => {
    expect(toOriginalKey('abc', 3, 'jpg')).toBe('original/abc/3/source.jpg');
    expect(toMasterKey('abc', 3)).toBe('master/abc/3/master.webp');
    expect(toStagingKey('upl_123')).toBe('staging/upl_123');
  });

  it('exposes a prefix covering one asset version for scoped cleanup', () => {
    expect(toDerivedPrefix('abc', 3, 1)).toBe('derived/abc/v3-1/');
  });
});
