/**
 * The transform grammar: raw query parameters in, normalized spec out.
 *
 * NOTE ON ZOD. The URL-facing parser below is hand-written pure functions rather
 * than a zod schema, deliberately. A subset of this logic is code-generated into the
 * CloudFront Function, which runs a restricted ES5-era runtime with a 10KB source
 * budget — zod cannot go there. Expressing the URL path in zod would mean
 * re-implementing zod's coercion edge cases (`z.coerce.number()` on `''`, on
 * `'1.5'`, on `'Infinity'`) by hand in the edge function and hoping they match. That
 * is precisely the drift that makes CloudFront cache one key while the generator
 * writes another — silent, permanent, invisible in error rates. Explicit parsing
 * keeps the two implementations trivially comparable. Zod guards the *programmatic*
 * surface instead (see `transformParamsSchema`), where no edge twin exists.
 *
 * See design.md D3 and D4.
 */

import { resolveDimensions } from './breakpoints.js';
import {
  DEFAULT_FIT,
  DEFAULT_GRAVITY,
  type BlurLevel,
  type CanonicalFit,
  type CropGravity,
  type FitMode,
  type SharpenLevel,
  CROP_GRAVITIES,
  FIT_MODES,
  fitCrops,
  fitUsesBackground,
  normalizeBackground,
  normalizeFit,
  quantizeBlur,
  quantizeSharpen,
} from './effects.js';
import {
  type OutputFormat,
  type RequestedFormat,
  REQUESTED_FORMATS,
  resolveFormat,
} from './formats.js';
import { type QualityLevel, resolveQuality } from './quality.js';

/** Raw, client-supplied parameters before normalization. */
export interface TransformParams {
  w?: number;
  h?: number;
  q?: number;
  fit?: FitMode;
  format?: RequestedFormat;
  crop?: CropGravity;
  background?: string;
  blur?: number;
  sharpen?: number;
  dpr?: number;
}

/**
 * A fully normalized transform. Every field is quantized, every inert field is
 * absent, and the format is concrete. Two requests producing identical pixels
 * produce identical specs — and therefore identical canonical keys.
 */
export interface TransformSpec {
  /** Ladder-snapped width. Absent means the source's intrinsic width. */
  width?: number;
  /** Derived from the quantized ratio. Present only when height was constrained. */
  height?: number;
  format: OutputFormat;
  quality: QualityLevel;
  /**
   * Present only when a height constraint makes the fit mode meaningful, and always
   * canonical — `pad` has already collapsed onto `contain`.
   */
  fit?: CanonicalFit;
  /** Present only when the fit crops and gravity is non-default. */
  gravity?: CropGravity;
  /** Present only when the fit pads. Canonical lowercase hex, no leading `#`. */
  background?: string;
  /** Present only when non-zero. */
  blur?: BlurLevel;
  /** Present only when non-zero. */
  sharpen?: SharpenLevel;
}

export interface TransformError {
  code: 'invalid_enum' | 'invalid_number' | 'unsupported_crop';
  parameter: string;
  message: string;
}

export type ParseResult = { ok: true; spec: TransformSpec } | { ok: false; error: TransformError };

const MAX_DPR = 3;
const MIN_DPR = 1;

/**
 * Parses a decimal number.
 *
 * Rejects rather than coerces: `'abc'`, `''`, `'1e5'`, and `'-5'` are all errors.
 * Out-of-range *values* are clamped later by their own quantizers; an unparseable
 * *string* is a client error, because silently treating it as a default would
 * deliver a differently-sized image than the caller asked for.
 */
function parseNumber(raw: string): number | undefined {
  if (!/^\d+(\.\d+)?$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function isFitMode(value: string): value is FitMode {
  return (FIT_MODES as readonly string[]).includes(value);
}

function isRequestedFormat(value: string): value is RequestedFormat {
  return (REQUESTED_FORMATS as readonly string[]).includes(value);
}

function isCropGravity(value: string): value is CropGravity {
  return (CROP_GRAVITIES as readonly string[]).includes(value);
}

/**
 * Parses raw query parameters into a normalized spec.
 *
 * Policy, per the transform-api spec:
 * - numeric values out of range are **clamped** — a slightly wrong URL keeps working
 * - unparseable numbers and unknown enum values are **rejected** — silently
 *   substituting a fit mode would deliver a visually wrong image
 * - unrecognized parameters are **ignored** and never reach the cache key
 *
 * @param params Raw string values, e.g. from a URLSearchParams.
 * @param accept Viewer's Accept header, consulted only when `format=auto`.
 * @param source Known source properties. Both fields are optional: the edge
 *   normalizer has neither, and must produce the same key without them.
 */
export function parseTransform(
  params: Record<string, string | undefined>,
  accept?: string,
  source?: { width?: number; hasAlpha?: boolean },
): ParseResult {
  const raw = (key: string): string | undefined => {
    const value = params[key];
    return value === undefined || value === '' ? undefined : value.trim().toLowerCase();
  };

  const numeric = (key: string): number | undefined | TransformError => {
    const value = raw(key);
    if (value === undefined) return undefined;
    const parsed = parseNumber(value);
    if (parsed === undefined) {
      return {
        code: 'invalid_number',
        parameter: key,
        message: `Expected a non-negative number for "${key}", received "${value}".`,
      };
    }
    return parsed;
  };

  const isError = (v: unknown): v is TransformError =>
    typeof v === 'object' && v !== null && 'code' in v;

  const w = numeric('w');
  if (isError(w)) return { ok: false, error: w };
  const h = numeric('h');
  if (isError(h)) return { ok: false, error: h };
  const q = numeric('q');
  if (isError(q)) return { ok: false, error: q };
  const blurRaw = numeric('blur');
  if (isError(blurRaw)) return { ok: false, error: blurRaw };
  const sharpenRaw = numeric('sharpen');
  if (isError(sharpenRaw)) return { ok: false, error: sharpenRaw };
  const dprRaw = numeric('dpr');
  if (isError(dprRaw)) return { ok: false, error: dprRaw };

  const fitRaw = raw('fit');
  if (fitRaw !== undefined && !isFitMode(fitRaw)) {
    return {
      ok: false,
      error: {
        code: 'invalid_enum',
        parameter: 'fit',
        message: `Unknown fit "${fitRaw}". Expected one of: ${FIT_MODES.join(', ')}.`,
      },
    };
  }

  const formatRaw = raw('format');
  if (formatRaw !== undefined && !isRequestedFormat(formatRaw)) {
    return {
      ok: false,
      error: {
        code: 'invalid_enum',
        parameter: 'format',
        message: `Unknown format "${formatRaw}". Expected one of: ${REQUESTED_FORMATS.join(', ')}.`,
      },
    };
  }

  const cropRaw = raw('crop');
  if (cropRaw !== undefined && !isCropGravity(cropRaw)) {
    // An absolute rectangle is the specific case worth naming: it is the one
    // parameter that would reintroduce an unbounded cache-key space.
    const looksLikeRect = /^\d+(,\d+){1,3}$/.test(cropRaw);
    return {
      ok: false,
      error: {
        code: looksLikeRect ? 'unsupported_crop' : 'invalid_enum',
        parameter: 'crop',
        message: looksLikeRect
          ? 'Absolute pixel crops are not supported on delivery URLs. Use a named gravity, or create a cropped asset through the API.'
          : `Unknown crop gravity "${cropRaw}". Expected one of: ${CROP_GRAVITIES.join(', ')}.`,
      },
    };
  }

  const dpr = dprRaw === undefined ? 1 : Math.min(Math.max(dprRaw, MIN_DPR), MAX_DPR);

  const { width, height } = resolveDimensions({
    width: w,
    height: h,
    dpr,
    sourceWidth: source?.width,
  });

  const format = resolveFormat(formatRaw ?? 'auto', accept, source?.hasAlpha ?? false);
  const quality = resolveQuality(q);

  const spec: TransformSpec = { format, quality };
  if (width !== undefined) spec.width = width;
  if (height !== undefined) spec.height = height;

  // Everything below is elided when it cannot affect the output. An inert parameter
  // left in the key fragments the cache exactly as badly as an unquantized one.
  //
  // Fit is meaningful only when *both* dimensions are constrained. With one
  // dimension the resize is proportional and every fit mode yields the same pixels,
  // so `?h=480` and `?h=480&fit=contain` must share a key.
  //
  // `pad` collapses onto `contain` here rather than surviving into the key: the two
  // reach sharp as the same call and produce the same bytes, so two keys would mean
  // two objects holding one image.
  const boxConstrained = width !== undefined && height !== undefined;
  const fit = normalizeFit(fitRaw ?? DEFAULT_FIT);

  if (boxConstrained) {
    spec.fit = fit;

    const gravity = cropRaw ?? DEFAULT_GRAVITY;
    if (fitCrops(fit) && gravity !== DEFAULT_GRAVITY) spec.gravity = gravity;

    if (fitUsesBackground(fit)) {
      const bgRaw = raw('background');
      const background = bgRaw === undefined ? undefined : normalizeBackground(bgRaw);
      if (background !== undefined) spec.background = background;
    }
  }

  const blur = blurRaw === undefined ? 0 : quantizeBlur(blurRaw);
  if (blur > 0) spec.blur = blur;

  const sharpen = sharpenRaw === undefined ? 0 : quantizeSharpen(sharpenRaw);
  if (sharpen > 0) spec.sharpen = sharpen;

  return { ok: true, spec };
}

/** Convenience wrapper for a URLSearchParams or query string. */
export function parseTransformFromQuery(
  query: URLSearchParams | string,
  accept?: string,
  source?: { width?: number; hasAlpha?: boolean },
): ParseResult {
  const search = typeof query === 'string' ? new URLSearchParams(query) : query;
  const params: Record<string, string> = {};
  for (const [key, value] of search) params[key] = value;
  return parseTransform(params, accept, source);
}
