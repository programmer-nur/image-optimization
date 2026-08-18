/**
 * The Sharp pipeline.
 *
 * Operation order is load-bearing, not stylistic — see the comments on each stage.
 * This module is the only place in `packages/core` that imports sharp, and it is
 * reachable only through the `@imgopt/core/pipeline` subpath so browser consumers of
 * the root entry point never pull a native module into their bundle.
 */

import sharp from 'sharp';
import type { FitEnum, Sharp } from 'sharp';
import type { TransformSpec } from '../transform-spec.js';
import { backgroundToRgba, type CanonicalFit, type CropGravity } from '../effects.js';
import { supportsAlpha } from '../formats.js';
import { encoderOptionsFor } from './encoder-options.js';
import { ProcessingError, classifyError } from './errors.js';

/**
 * Decompression-bomb ceiling.
 *
 * A ~30KB PNG can declare dimensions that decode to tens of gigabytes. Without this,
 * one crafted upload takes down the worker. Non-negotiable.
 */
export const DEFAULT_MAX_PIXELS = 100_000_000;

/** Fill used when flattening alpha into a format that cannot carry it. */
export const DEFAULT_FLATTEN_BACKGROUND = { r: 255, g: 255, b: 255, alpha: 1 };

export interface RenderOptions {
  maxPixels?: number;
  /** Applied when the output format has no alpha channel and the source does. */
  flattenBackground?: { r: number; g: number; b: number; alpha: number };
}

export interface RenderResult {
  data: Buffer;
  format: string;
  width: number;
  height: number;
  bytes: number;
}

/** Maps our gravity names onto sharp's position constants. */
function positionFor(gravity: CropGravity | undefined): string | number {
  switch (gravity) {
    case 'top':
      return 'top';
    case 'bottom':
      return 'bottom';
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'entropy':
      return sharp.strategy.entropy;
    case 'attention':
      return sharp.strategy.attention;
    case 'center':
    default:
      return 'centre';
  }
}

/** Sharp's `fit` vocabulary. The spec's fits are already canonical. */
function fitFor(fit: CanonicalFit | undefined): keyof FitEnum {
  switch (fit) {
    case 'contain':
      return 'contain';
    case 'inside':
      return 'inside';
    case 'outside':
      return 'outside';
    case 'fill':
      return 'fill';
    case 'cover':
    default:
      return 'cover';
  }
}

/**
 * Builds the transform chain for a normalized spec.
 *
 * Exposed separately from `render` so callers holding a stream can compose without
 * buffering the whole source.
 */
export function buildPipeline(spec: TransformSpec, options: RenderOptions = {}): Sharp {
  const pipeline = sharp({
    limitInputPixels: options.maxPixels ?? DEFAULT_MAX_PIXELS,
    // Fail on truncation rather than emitting a half-decoded image. A partially
    // rendered derivative would be cached for a year under an immutable URL.
    failOn: 'truncated',
    // Streams the source rather than random-accessing it, which materially lowers
    // peak memory on large JPEGs.
    sequentialRead: true,
  });

  return applyTransform(pipeline, spec, options);
}

/** Applies the transform chain to an existing sharp instance. */
export function applyTransform(
  pipeline: Sharp,
  spec: TransformSpec,
  options: RenderOptions = {},
): Sharp {
  let chain = pipeline;

  // 1. Orientation FIRST. `rotate()` with no argument applies the EXIF orientation
  //    tag and then drops it. Run after resize instead, and a portrait photo stored
  //    with orientation 6 is resized against its landscape stored dimensions and
  //    comes out the wrong shape.
  chain = chain.rotate();

  // 2. Resize. `withoutEnlargement` is what enforces the never-upscale rule: the
  //    canonical key may name a bucket wider than the source, but the pixels are
  //    capped here. See design.md D3.
  if (spec.width !== undefined || spec.height !== undefined) {
    const background =
      spec.background !== undefined
        ? backgroundToRgba(spec.background)
        : (options.flattenBackground ?? DEFAULT_FLATTEN_BACKGROUND);

    chain = chain.resize({
      ...(spec.width !== undefined ? { width: spec.width } : {}),
      ...(spec.height !== undefined ? { height: spec.height } : {}),
      fit: fitFor(spec.fit),
      position: positionFor(spec.gravity),
      background,
      withoutEnlargement: true,
    });
  }

  // 3. Effects, after resize so the sigma is relative to output pixels rather than
  //    source pixels — otherwise the same blur value looks different per size.
  if (spec.blur !== undefined && spec.blur > 0) chain = chain.blur(spec.blur);
  if (spec.sharpen !== undefined && spec.sharpen > 0) {
    chain = chain.sharpen({ sigma: spec.sharpen });
  }

  // 4. Flatten before encoding when the target cannot carry alpha, otherwise
  //    transparent regions render black instead of the requested background.
  if (!supportsAlpha(spec.format)) {
    const background =
      spec.background !== undefined
        ? backgroundToRgba(spec.background)
        : (options.flattenBackground ?? DEFAULT_FLATTEN_BACKGROUND);
    chain = chain.flatten({ background });
  }

  // 5. Normalize colour. Converting into sRGB is correct for delivery; passing a
  //    wide-gamut profile through untouched renders oversaturated on most displays,
  //    and re-attaching the profile costs bytes for no benefit.
  chain = chain.toColorspace('srgb');

  // 6. Encode. Metadata is dropped because sharp does not copy it unless asked —
  //    which strips GPS coordinates from user photos and typically 10-50KB.
  chain = chain.toFormat(spec.format, encoderOptionsFor(spec.format, spec.quality, spec.width));

  return chain;
}

/** Renders a derivative from source bytes. */
export async function render(
  input: Buffer | Uint8Array,
  spec: TransformSpec,
  options: RenderOptions = {},
): Promise<RenderResult> {
  try {
    const pipeline = sharp(input, {
      limitInputPixels: options.maxPixels ?? DEFAULT_MAX_PIXELS,
      failOn: 'truncated',
      sequentialRead: true,
    });

    const { data, info } = await applyTransform(pipeline, spec, options).toBuffer({
      resolveWithObject: true,
    });

    return {
      data,
      format: info.format,
      width: info.width,
      height: info.height,
      bytes: data.length,
    };
  } catch (error) {
    throw classifyError(error);
  }
}

/** Renders with a wall-clock budget, so a pathological source cannot pin a worker. */
export async function renderWithTimeout(
  input: Buffer | Uint8Array,
  spec: TransformSpec,
  timeoutMs: number,
  options: RenderOptions = {},
): Promise<RenderResult> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProcessingError('timeout', `Generation exceeded ${timeoutMs}ms.`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([render(input, spec, options), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
