/**
 * Perceptual quality level -> per-codec encoder settings.
 *
 * The nominal levels in `quality.ts` describe how an image should *look*. Codecs
 * disagree wildly about what a given number means, so each gets its own calibrated
 * mapping. Reading across a row gives roughly comparable appearance at very
 * different file sizes — which is the entire point, since bandwidth is ~75% of the
 * running cost and encoding is paid once per variant.
 *
 * Encoding effort is set high relative to typical defaults for the same reason: a
 * derivative is encoded once and delivered indefinitely, so trading generation
 * milliseconds for delivered bytes is almost always correct.
 */

import type { AvifOptions, JpegOptions, PngOptions, WebpOptions } from 'sharp';
import type { QualityLevel } from '../quality.js';
import type { OutputFormat } from '../formats.js';

/**
 * Above this width, AVIF encoding effort drops.
 *
 * High-effort AVIF on a 4K image can take seconds and risks the Lambda timeout.
 * The size benefit of extra effort also shrinks as resolution grows, so this costs
 * little. See design.md D10.
 */
export const AVIF_EFFORT_REDUCTION_WIDTH = 1920;

const AVIF_EFFORT_DEFAULT = 4;
const AVIF_EFFORT_LARGE = 2;

/** Nominal level -> mozjpeg quality. */
const JPEG_QUALITY: Record<QualityLevel, number> = {
  50: 55,
  65: 68,
  75: 78,
  85: 88,
  95: 96,
};

/** Nominal level -> WebP quality. */
const WEBP_QUALITY: Record<QualityLevel, number> = {
  50: 50,
  65: 62,
  75: 72,
  85: 82,
  95: 93,
};

/**
 * Nominal level -> AVIF quality.
 *
 * Markedly lower numbers than the other codecs for the same appearance, which is
 * exactly why AVIF wins on size.
 */
const AVIF_QUALITY: Record<QualityLevel, number> = {
  50: 34,
  65: 42,
  75: 50,
  85: 62,
  95: 80,
};

/**
 * PNG is lossless, so quality maps to palette quantization rather than to a quality
 * knob. Above the palette threshold the image is stored full-colour and only
 * deflate settings apply.
 */
const PNG_PALETTE_QUALITY: Record<QualityLevel, number | undefined> = {
  50: 60,
  65: 75,
  75: 85,
  85: undefined,
  95: undefined,
};

export function jpegOptions(quality: QualityLevel): JpegOptions {
  return {
    quality: JPEG_QUALITY[quality],
    // Consistently 5-10% smaller than libjpeg at equal quality.
    mozjpeg: true,
    progressive: true,
    // Chroma subsampling is invisible at ordinary quality but shows on hard edges
    // and saturated colour, so it is disabled once the caller asks for high fidelity.
    chromaSubsampling: quality >= 95 ? '4:4:4' : '4:2:0',
  };
}

export function webpOptions(quality: QualityLevel): WebpOptions {
  return {
    quality: WEBP_QUALITY[quality],
    effort: 5,
    smartSubsample: true,
  };
}

export function avifOptions(quality: QualityLevel, outputWidth?: number): AvifOptions {
  const large = outputWidth !== undefined && outputWidth > AVIF_EFFORT_REDUCTION_WIDTH;
  return {
    quality: AVIF_QUALITY[quality],
    effort: large ? AVIF_EFFORT_LARGE : AVIF_EFFORT_DEFAULT,
    chromaSubsampling: quality >= 95 ? '4:4:4' : '4:2:0',
  };
}

export function pngOptions(quality: QualityLevel): PngOptions {
  const paletteQuality = PNG_PALETTE_QUALITY[quality];

  if (paletteQuality === undefined) {
    return { compressionLevel: 9, effort: 8, palette: false };
  }
  return {
    compressionLevel: 9,
    effort: 8,
    palette: true,
    quality: paletteQuality,
    dither: 1,
  };
}

export type EncoderOptions = JpegOptions | PngOptions | WebpOptions | AvifOptions;

/** Resolves encoder settings for a format at a nominal quality level. */
export function encoderOptionsFor(
  format: OutputFormat,
  quality: QualityLevel,
  outputWidth?: number,
): EncoderOptions {
  switch (format) {
    case 'jpeg':
      return jpegOptions(quality);
    case 'webp':
      return webpOptions(quality);
    case 'avif':
      return avifOptions(quality, outputWidth);
    case 'png':
      return pngOptions(quality);
  }
}
