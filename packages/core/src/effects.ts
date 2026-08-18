/**
 * Effect and fit quantization.
 *
 * Every one of these is a cache-key axis. An unquantized axis — or an inert
 * parameter left in the key — fragments the cache exactly as badly as an
 * unbucketed width would.
 */

/**
 * Resize behaviour a caller may ask for. Mirrors Sharp's fit modes plus `pad`.
 *
 * `pad` is an alias, not a mode: it and `contain` reach sharp as the same `contain`
 * call with the same background, so they produce byte-identical output. Accepting
 * both spellings is a convenience for callers coming from other image CDNs; letting
 * both reach the *key* would mean two objects, two generations, and two cache entries
 * holding the same bytes. `normalizeFit` collapses it at parse time, which is why
 * `CANONICAL_FIT_MODES` — not this list — is what a spec and a key may contain.
 */
export const FIT_MODES = ['cover', 'contain', 'inside', 'outside', 'fill', 'pad'] as const;
export type FitMode = (typeof FIT_MODES)[number];

/** The fits that survive normalization and may appear in a canonical key. */
export const CANONICAL_FIT_MODES = ['cover', 'contain', 'inside', 'outside', 'fill'] as const;
export type CanonicalFit = (typeof CANONICAL_FIT_MODES)[number];

export const DEFAULT_FIT: FitMode = 'cover';

/** Collapses accepted spellings onto the canonical set. */
export function normalizeFit(fit: FitMode): CanonicalFit {
  return fit === 'pad' ? 'contain' : fit;
}

/** Fits that can leave empty area, and so can meaningfully take a background. */
const PADDING_FITS = new Set<CanonicalFit>(['contain']);

export function fitUsesBackground(fit: CanonicalFit): boolean {
  return PADDING_FITS.has(fit);
}

/**
 * Fits that discard source pixels, and so can meaningfully take a gravity.
 *
 * `cover` alone. `outside` resizes so the result *covers* the requested box and then
 * returns it whole — sharp never crops it, so every gravity yields identical pixels.
 * Carrying gravity in an `outside` key would multiply that variant by the size of the
 * gravity enum, each object holding the same bytes.
 */
const CROPPING_FITS = new Set<CanonicalFit>(['cover']);

export function fitCrops(fit: CanonicalFit): boolean {
  return CROPPING_FITS.has(fit);
}

/**
 * Crop gravity. Named values only.
 *
 * Absolute pixel rectangles are deliberately absent: `crop=x,y,w,h` reintroduces an
 * unbounded key space and would single-handedly undo bucketing. Arbitrary rectangles
 * go through the authenticated API, which mints a new asset — which is also the
 * honest model of their cost. See design.md D3.
 *
 * `focal` is deliberately absent too, and for a different reason. A stored focal
 * point lives in the registry, and the delivery plane never reads the registry — so
 * the generator, handed only a key, has no way to honour it. It rendered as centre,
 * which meant `crop=focal` minted a second key holding bytes identical to the elided
 * centre key: fragmentation dressed as a feature. It stays out of the URL grammar
 * until a design decision says how a focal point can reach the delivery path.
 */
export const CROP_GRAVITIES = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'entropy',
  'attention',
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
 * Channel values a background may take: the sixteen 4-bit levels, `00` to `ff`.
 *
 * Every other axis of the key is quantized, and this one was not. Full 8-bit hex is
 * 2^24 distinct backgrounds per box — 2^32 with alpha — each of them a Sharp
 * invocation, a permanent object, and a permanent cache entry, all reachable from an
 * ordinary delivery URL by anyone who can read an asset id out of a page. That is the
 * same unbounded-key-space hole the width ladder exists to close, spelled in hex.
 *
 * Four bits per channel is chosen rather than fewer because the parameter only
 * applies to padding bars, which are flat colour: banding cannot appear in a solid
 * fill, and 4096 colours (times 16 alpha steps) is far more than a letterbox needs.
 * The step is 17, so the levels are exactly `00, 11, 22, … ff` — which means the
 * three-digit shorthand everyone writes (`fa0` → `ffaa00`) is already on the grid and
 * survives untouched.
 */
export const BACKGROUND_CHANNEL_STEP = 17;

function quantizeChannel(byte: number): string {
  const level = Math.round(byte / BACKGROUND_CHANNEL_STEP) * BACKGROUND_CHANNEL_STEP;
  return level < 16 ? `0${level.toString(16)}` : level.toString(16);
}

/** Whether a normalized hex string is on the channel grid. */
export function isQuantizedBackground(hex: string): boolean {
  for (let i = 0; i < hex.length; i += 2) {
    if (parseInt(hex.slice(i, i + 2), 16) % BACKGROUND_CHANNEL_STEP !== 0) return false;
  }
  return true;
}

/**
 * Normalizes a background colour to canonical lowercase hex without `#`.
 *
 * Accepts 3, 4, 6, and 8 digit forms and expands shorthand, so `#FA0`, `ffaa00`, and
 * `#FFAA00` all collapse to one cache key. Channels are then snapped to the 4-bit
 * grid, which is what keeps this axis finite. Returns undefined for anything
 * unparseable, letting the caller decide between rejecting and ignoring.
 */
export function normalizeBackground(raw: string): string | undefined {
  const hex = raw.trim().replace(/^#/, '').toLowerCase();

  if (!/^[0-9a-f]+$/.test(hex)) return undefined;

  const expanded = hex.length === 3 || hex.length === 4 ? [...hex].map((c) => c + c).join('') : hex;

  if (expanded.length !== 6 && expanded.length !== 8) return undefined;

  let quantized = '';
  for (let i = 0; i < expanded.length; i += 2) {
    quantized += quantizeChannel(parseInt(expanded.slice(i, i + 2), 16));
  }
  return quantized;
}

/** Splits a normalized hex string into Sharp's background object. */
export function backgroundToRgba(hex: string): { r: number; g: number; b: number; alpha: number } {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, alpha };
}
