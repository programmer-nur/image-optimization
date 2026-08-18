/**
 * Intrinsic metadata extraction and placeholder generation.
 *
 * DECODE GUARD. Every function here that hands bytes to sharp sets
 * `limitInputPixels`, for the same reason `render` does: a ~30KB PNG can declare
 * dimensions that decode to tens of gigabytes. Sharp's own default is not "none", but
 * it is ~268 megapixels — roughly 2.7x the cap this deployment configures — so an
 * unset option here quietly overrides the operator's ceiling on exactly the paths a
 * crafted upload reaches first. The cap is a parameter rather than a constant because
 * `UPLOAD_MAX_PIXELS` is a deployment setting, and a guard that ignores it is a guard
 * in name only.
 */

import sharp from 'sharp';
import { classifyError } from './errors.js';
import { DEFAULT_MAX_PIXELS } from './render.js';

/** Shared by every decode entry point here. */
export interface DecodeLimits {
  maxPixels?: number;
}

export interface SourceMetadata {
  /** Displayed width, after EXIF orientation is accounted for. */
  width: number;
  /** Displayed height, after EXIF orientation is accounted for. */
  height: number;
  format: string;
  bytes: number;
  hasAlpha: boolean;
  colorspace: string;
  /** Raw EXIF orientation tag, 1-8. Absent when the source carries none. */
  orientation?: number;
  /** Whether width/height were swapped relative to the stored dimensions. */
  orientationSwapsAxes: boolean;
  /** Frames in the source. 1 for a still; GIF and animated WebP can carry more. */
  pages: number;
  /**
   * Whether the source carries more than one frame.
   *
   * Reported because the pipeline does not preserve animation: every derivative is
   * re-encoded from the first frame, which is what a still-image transform grammar
   * can express. An animated GIF or WebP is therefore accepted and delivered as its
   * opening frame — a defensible outcome, but a surprising one to discover from the
   * rendered page, so the fact is surfaced here rather than left implicit.
   */
  isAnimated: boolean;
}

/** EXIF orientations 5-8 involve a 90 degree rotation, transposing the axes. */
function swapsAxes(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8;
}

/**
 * Reads intrinsic properties of a source image.
 *
 * Reports **displayed** dimensions, not stored ones. A photo shot in portrait is
 * commonly stored landscape with an orientation tag telling viewers to rotate it;
 * sharp's `metadata()` reports the stored values. Passing those on unchanged would
 * give clients a transposed aspect ratio — wrong `width`/`height` attributes, layout
 * shift, and `srcset` candidates capped against the wrong axis.
 */
export async function readMetadata(
  input: Buffer | Uint8Array,
  options: DecodeLimits = {},
): Promise<SourceMetadata> {
  try {
    const image = sharp(input, {
      limitInputPixels: options.maxPixels ?? DEFAULT_MAX_PIXELS,
      failOn: 'truncated',
    });
    const meta = await image.metadata();

    const storedWidth = meta.width ?? 0;
    const storedHeight = meta.height ?? 0;
    const swap = swapsAxes(meta.orientation);
    const pages = meta.pages ?? 1;

    return {
      width: swap ? storedHeight : storedWidth,
      height: swap ? storedWidth : storedHeight,
      format: meta.format ?? 'unknown',
      bytes: meta.size ?? input.byteLength,
      hasAlpha: meta.hasAlpha ?? false,
      colorspace: meta.space ?? 'unknown',
      ...(meta.orientation !== undefined ? { orientation: meta.orientation } : {}),
      orientationSwapsAxes: swap,
      pages,
      isAnimated: pages > 1,
    };
  } catch (error) {
    throw classifyError(error);
  }
}

/** Average colour of the source, for solid placeholder backgrounds. */
export async function readDominantColor(
  input: Buffer | Uint8Array,
  options: DecodeLimits = {},
): Promise<string> {
  try {
    // `stats()` decodes the whole image to compute the average, so this is a full
    // decode wearing a small-sounding name.
    const { dominant } = await sharp(input, {
      limitInputPixels: options.maxPixels ?? DEFAULT_MAX_PIXELS,
      failOn: 'truncated',
      sequentialRead: true,
    }).stats();
    const hex = (v: number): string => v.toString(16).padStart(2, '0');
    return `${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
  } catch (error) {
    throw classifyError(error);
  }
}

export interface LqipOptions extends DecodeLimits {
  width?: number;
  quality?: number;
}

/**
 * Generates a low-quality image placeholder as a data URI.
 *
 * Returned inline rather than stored in S3 and served: the whole value of a
 * few-hundred-byte placeholder is that it arrives *with* the HTML. A network
 * round-trip to fetch one would cost more than the image it stands in for. Stored on
 * the asset version row and inlined by the client SDK.
 */
export async function generateLqip(
  input: Buffer | Uint8Array,
  options: LqipOptions = {},
): Promise<string> {
  const width = options.width ?? 24;
  const quality = options.quality ?? 40;

  try {
    const data = await sharp(input, {
      limitInputPixels: options.maxPixels ?? DEFAULT_MAX_PIXELS,
      failOn: 'truncated',
      sequentialRead: true,
    })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality, effort: 6, alphaQuality: 50 })
      .toBuffer();

    return `data:image/webp;base64,${data.toString('base64')}`;
  } catch (error) {
    throw classifyError(error);
  }
}

export interface MasterOptions extends DecodeLimits {
  longestEdge?: number;
  quality?: number;
}

/**
 * Produces a bounded, quality-preserving intermediate.
 *
 * Only worth generating for very large sources. Every cache miss otherwise decodes
 * the full original, so a 12000x8000 TIFF means decoding 96 megapixels per miss;
 * against a 4000px master that drops by roughly an order of magnitude. Never served
 * to clients. See design.md D7.
 */
export async function generateMaster(
  input: Buffer | Uint8Array,
  options: MasterOptions = {},
): Promise<Buffer> {
  const longestEdge = options.longestEdge ?? 4000;
  const quality = options.quality ?? 92;

  try {
    return await sharp(input, {
      limitInputPixels: options.maxPixels ?? DEFAULT_MAX_PIXELS,
      failOn: 'truncated',
      sequentialRead: true,
    })
      .rotate()
      .resize({ width: longestEdge, height: longestEdge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toBuffer();
  } catch (error) {
    throw classifyError(error);
  }
}

/** Whether a source is large enough to justify a master rendition. */
export function needsMaster(
  metadata: Pick<SourceMetadata, 'width' | 'height' | 'bytes'>,
  thresholds: { bytes: number; longestEdge: number },
): boolean {
  return (
    metadata.bytes > thresholds.bytes ||
    Math.max(metadata.width, metadata.height) > thresholds.longestEdge
  );
}
