/**
 * Effect and fit quantization.
 *
 * Every one of these is a cache-key axis. An unquantized axis — or an inert
 * parameter left in the key — fragments the cache exactly as badly as an
 * unbucketed width would.
 */

/** Resize behaviour. Mirrors Sharp's fit modes plus an explicit `pad`. */
export const FIT_MODES = ['cover', 'contain', 'inside', 'outside', 'fill', 'pad'] as const;
export type FitMode = (typeof FIT_MODES)[number];

export const DEFAULT_FIT: FitMode = 'cover';

/** Fits that can leave empty area, and so can meaningfully take a background. */
const PADDING_FITS = new Set<FitMode>(['contain', 'pad']);

export function fitUsesBackground(fit: FitMode): boolean {
  return PADDING_FITS.has(fit);
}

/** Fits that discard source pixels, and so can meaningfully take a gravity. */
const CROPPING_FITS = new Set<FitMode>(['cover', 'outside']);

export function fitCrops(fit: FitMode): boolean {
  return CROPPING_FITS.has(fit);
}

/**
 * Crop gravity. Named values only.
 *
 * Absolute pixel rectangles are deliberately absent: `crop=x,y,w,h` reintroduces an
 * unbounded key space and would single-handedly undo bucketing. Arbitrary rectangles
 * go through the authenticated API, which mints a new asset — which is also the
 * honest model of their cost. See design.md D3.
 */
export const CROP_GRAVITIES = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'entropy',
  'attention',
  'focal',
] as const;
export type CropGravity = (typeof CROP_GRAVITIES)[number];

export const DEFAULT_GRAVITY: CropGravity = 'center';

/** Permitted blur sigmas. 0 means no blur and is elided from the key. */
export const BLUR_LEVELS = [0, 2, 5, 10, 20, 40] as const;
export type BlurLevel = (typeof BLUR_LEVELS)[number];

/** Permitted sharpen levels. 0 means no sharpen and is elided from the key. */
export const SHARPEN_LEVELS = [0, 1, 2] as const;
export type SharpenLevel = (typeof SHARPEN_LEVELS)[number];

function nearest<T extends number>(levels: readonly T[], requested: number, fallback: T): T {
  let best = fallback;
  let bestDelta = Infinity;
  for (const level of levels) {
    const delta = Math.abs(requested - level);
    if (delta < bestDelta) {
      best = level;
      bestDelta = delta;
    }
  }
  return best;
}

export function quantizeBlur(requested: number): BlurLevel {
  return nearest(BLUR_LEVELS, Math.max(requested, 0), 0);
}

export function quantizeSharpen(requested: number): SharpenLevel {
  return nearest(SHARPEN_LEVELS, Math.max(requested, 0), 0);
}

/**
 * Normalizes a background colour to canonical lowercase hex without `#`.
 *
 * Accepts 3, 4, 6, and 8 digit forms and expands shorthand, so `#FA0`, `ffaa00`, and
 * `#FFAA00` all collapse to one cache key. Returns undefined for anything
 * unparseable, letting the caller decide between rejecting and ignoring.
 */
export function normalizeBackground(raw: string): string | undefined {
  const hex = raw.trim().replace(/^#/, '').toLowerCase();

  if (!/^[0-9a-f]+$/.test(hex)) return undefined;

  if (hex.length === 3 || hex.length === 4) {
    return [...hex].map((c) => c + c).join('');
  }
  if (hex.length === 6 || hex.length === 8) return hex;

  return undefined;
}

/** Splits a normalized hex string into Sharp's background object. */
export function backgroundToRgba(hex: string): { r: number; g: number; b: number; alpha: number } {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, alpha };
}
