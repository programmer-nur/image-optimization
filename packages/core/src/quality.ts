/**
 * Quality quantization.
 *
 * Quality is an axis of the cache key like any other, so it is snapped to a small
 * fixed set. Unlike width it snaps to the *nearest* level rather than upward:
 * perceived quality is subjective and the levels are coarse, so nearest minimises
 * deviation from what was asked for in both directions.
 */

export const QUALITY_LEVELS = [50, 65, 75, 85, 95] as const;
export type QualityLevel = (typeof QUALITY_LEVELS)[number];

export const MIN_QUALITY = QUALITY_LEVELS[0];
export const MAX_QUALITY = QUALITY_LEVELS[QUALITY_LEVELS.length - 1] as number;

/**
 * Per-format defaults.
 *
 * The levels are a **perceptual** scale, not raw codec settings. Equal numeric
 * quality does not mean equal perceptual quality across codecs — AVIF near 50 looks
 * about like JPEG near 78 — so `encoder-options.ts` translates each nominal level
 * into per-codec settings.
 *
 * The alternative, treating `q` as a raw codec value, quietly destroys the main cost
 * lever: a caller asking for the perfectly reasonable `?q=75` would hand AVIF a
 * near-lossless setting and produce files several times larger than needed, giving
 * back most of what AVIF was adopted for. One perceptual scale, translated per
 * codec, is what makes `?q=75` mean the same thing to every client.
 */
export const DEFAULT_QUALITY: QualityLevel = 75;

/** Snaps to the nearest permitted level, ties resolving upward. */
export function quantizeQuality(requested: number): QualityLevel {
  const clamped = Math.min(Math.max(requested, MIN_QUALITY), MAX_QUALITY);

  let best: QualityLevel = QUALITY_LEVELS[0];
  let bestDelta = Infinity;
  for (const level of QUALITY_LEVELS) {
    const delta = Math.abs(clamped - level);
    if (delta < bestDelta) {
      best = level;
      bestDelta = delta;
    }
  }
  return best;
}

/** Resolves quality for a request, falling back to the shared perceptual default. */
export function resolveQuality(requested: number | undefined): QualityLevel {
  return requested === undefined ? DEFAULT_QUALITY : quantizeQuality(requested);
}
