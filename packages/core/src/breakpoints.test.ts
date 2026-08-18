import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LADDER,
  MAX_LADDER_WIDTH,
  MIN_LADDER_WIDTH,
  RATIOS,
  RATIO_TOLERANCE,
  capToSource,
  quantizeRatio,
  resolveDimensions,
  snapUp,
  snapWidth,
} from './breakpoints.js';

describe('ladder', () => {
  it('is strictly ascending', () => {
    for (let i = 1; i < LADDER.length; i++) {
      expect(LADDER[i]!).toBeGreaterThan(LADDER[i - 1]!);
    }
  });

  it('covers icon scale so small images are not forced up to display sizes', () => {
    expect(MIN_LADDER_WIDTH).toBe(16);
    expect(LADDER).toContain(32);
    expect(LADDER).toContain(64);
  });

  it('tops out at 4K', () => {
    expect(MAX_LADDER_WIDTH).toBe(3840);
  });
});

describe('snapUp', () => {
  it('snaps up, never down', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_LADDER_WIDTH }), (width) => {
        expect(snapUp(width)).toBeGreaterThanOrEqual(width);
      }),
    );
  });

  it('always lands on a ladder rung', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20_000 }), (width) => {
        expect(LADDER).toContain(snapUp(width));
      }),
    );
  });

  it('picks the smallest rung that fits', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_LADDER_WIDTH }), (width) => {
        const result = snapUp(width);
        const smaller = LADDER.filter((rung) => rung >= width && rung < result);
        expect(smaller).toEqual([]);
      }),
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20_000 }), (width) => {
        expect(snapUp(snapUp(width))).toBe(snapUp(width));
      }),
    );
  });
});

describe('snapWidth', () => {
  it('never exceeds the ladder maximum', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({ min: 1, max: 3 }),
        (w, dpr) => {
          expect(snapWidth(w, dpr)).toBeLessThanOrEqual(MAX_LADDER_WIDTH);
        },
      ),
    );
  });

  it('folds dpr into the width before snapping', () => {
    expect(snapWidth(400, 2)).toBe(snapWidth(800, 1));
    expect(snapWidth(320, 2)).toBe(snapWidth(640, 1));
  });

  it('caps at the source width when the source is known', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 4000 }),
        (requested, sourceWidth) => {
          expect(snapWidth(requested, 1, sourceWidth)).toBeLessThanOrEqual(
            Math.max(sourceWidth, MIN_LADDER_WIDTH),
          );
        },
      ),
    );
  });

  it('skips the cap when the source width is unknown, as at the edge', () => {
    // The edge normalizer has no asset metadata. The key names the requested
    // bucket; the pipeline still refuses to enlarge. See design.md D3.
    expect(snapWidth(3840, 1, undefined)).toBe(3840);
    expect(snapWidth(3840, 1, 2000)).toBe(1920);
  });
});

describe('capToSource', () => {
  it('leaves widths at or below the source untouched', () => {
    expect(capToSource(640, 2000)).toBe(640);
    expect(capToSource(2000, 2000)).toBe(2000);
  });

  it('drops to the largest rung not exceeding the source', () => {
    expect(capToSource(3840, 2000)).toBe(1920);
    expect(capToSource(3840, 1000)).toBe(960);
  });

  it('floors at the smallest rung for sources below it', () => {
    // A native-width key is a key no viewer URL can ask for: the edge snaps every
    // requested width up to a rung, so `w12` would be written once and read never.
    // The pipeline still delivers the source's own 12 pixels under `w16`.
    expect(capToSource(16, 12)).toBe(16);
    expect(capToSource(3840, 1)).toBe(16);
  });
});

describe('quantizeRatio', () => {
  it('snaps common shapes exactly', () => {
    expect(quantizeRatio(9 / 16)).toBeCloseTo(9 / 16, 10);
    expect(quantizeRatio(1)).toBe(1);
    expect(quantizeRatio(3 / 4)).toBeCloseTo(3 / 4, 10);
  });

  it('absorbs near-misses within tolerance', () => {
    // 362/640 is 0.5656 against 16:9's 0.5625 — inside 3%.
    expect(quantizeRatio(362 / 640)).toBeCloseTo(9 / 16, 10);
    expect(quantizeRatio(356 / 640)).toBeCloseTo(9 / 16, 10);
  });

  it('keeps unusual ratios distinct rather than distorting them', () => {
    const unusual = quantizeRatio(0.9);
    expect(unusual).toBeCloseTo(0.9, 5);
    expect(RATIOS).not.toContain(unusual);
  });

  it('is idempotent for listed ratios', () => {
    for (const ratio of RATIOS) {
      expect(quantizeRatio(quantizeRatio(ratio))).toBeCloseTo(quantizeRatio(ratio), 10);
    }
  });

  it('stays within tolerance of the requested ratio or falls back to 2dp', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.05, max: 20, noNaN: true }), (ratio) => {
        const result = quantizeRatio(ratio);
        const matched = RATIOS.some((r) => Math.abs(ratio - r) / r <= RATIO_TOLERANCE);
        if (matched) {
          expect(Math.abs(result - ratio) / result).toBeLessThanOrEqual(RATIO_TOLERANCE * 1.5);
        } else {
          expect(Math.abs(result - ratio)).toBeLessThanOrEqual(0.005);
        }
      }),
    );
  });

  it('bounds the axis for extreme ratios', () => {
    expect(quantizeRatio(1000)).toBeLessThanOrEqual(20);
    expect(quantizeRatio(0.0001)).toBeGreaterThanOrEqual(0.05);
  });
});

describe('resolveDimensions', () => {
  it('derives height from the source when only a width is given', () => {
    expect(resolveDimensions({ width: 602 })).toEqual({ width: 640 });
  });

  it('derives width from the source when only a height is given', () => {
    expect(resolveDimensions({ height: 480 })).toEqual({ height: 480 });
  });

  it('snaps the width then derives height from the quantized ratio', () => {
    expect(resolveDimensions({ width: 602, height: 339 })).toEqual({ width: 640, height: 360 });
  });

  it('returns an empty box when nothing is constrained', () => {
    expect(resolveDimensions({})).toEqual({});
  });

  it('always produces ladder widths', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6000 }),
        fc.option(fc.integer({ min: 1, max: 6000 }), { nil: undefined }),
        (width, height) => {
          const result = resolveDimensions({ width, height });
          expect(LADDER).toContain(result.width!);
        },
      ),
    );
  });
});
