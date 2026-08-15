import { describe, expect, it } from 'vitest';
import { QUALITY_LEVELS, type QualityLevel } from '../quality.js';
import { OUTPUT_FORMATS } from '../formats.js';
import {
  AVIF_EFFORT_REDUCTION_WIDTH,
  avifOptions,
  encoderOptionsFor,
  jpegOptions,
  pngOptions,
  webpOptions,
} from './encoder-options.js';

describe('perceptual to codec translation', () => {
  it('maps every nominal level for every format', () => {
    for (const format of OUTPUT_FORMATS) {
      for (const level of QUALITY_LEVELS) {
        expect(encoderOptionsFor(format, level), `${format}@${level}`).toBeDefined();
      }
    }
  });

  it('is monotonic in quality for the lossy codecs', () => {
    const jpeg = QUALITY_LEVELS.map((q) => jpegOptions(q).quality!);
    const webp = QUALITY_LEVELS.map((q) => webpOptions(q).quality!);
    const avif = QUALITY_LEVELS.map((q) => avifOptions(q).quality!);

    for (const series of [jpeg, webp, avif]) {
      for (let i = 1; i < series.length; i++) {
        expect(series[i]!).toBeGreaterThan(series[i - 1]!);
      }
    }
  });

  it('gives AVIF markedly lower raw numbers than JPEG for the same appearance', () => {
    // The whole reason quality is a perceptual scale rather than a raw codec value:
    // passing 75 straight through to AVIF would produce a near-lossless file and
    // give back most of the format's size advantage.
    for (const level of QUALITY_LEVELS) {
      expect(avifOptions(level).quality!).toBeLessThan(jpegOptions(level).quality!);
    }
  });
});

describe('AVIF effort', () => {
  it('uses full effort at ordinary sizes', () => {
    expect(avifOptions(75, 1080).effort).toBe(4);
    expect(avifOptions(75, AVIF_EFFORT_REDUCTION_WIDTH).effort).toBe(4);
  });

  it('drops effort above the threshold to bound generation time', () => {
    // High-effort AVIF on a 4K frame risks the Lambda timeout, and the size benefit
    // of extra effort shrinks as resolution grows.
    expect(avifOptions(75, AVIF_EFFORT_REDUCTION_WIDTH + 1).effort).toBe(2);
    expect(avifOptions(75, 3840).effort).toBe(2);
  });

  it('uses full effort when the width is unknown', () => {
    expect(avifOptions(75).effort).toBe(4);
  });
});

describe('format-specific settings', () => {
  it('enables mozjpeg and progressive JPEG', () => {
    const options = jpegOptions(75);
    expect(options.mozjpeg).toBe(true);
    expect(options.progressive).toBe(true);
  });

  it('disables chroma subsampling only at the top quality level', () => {
    expect(jpegOptions(75).chromaSubsampling).toBe('4:2:0');
    expect(jpegOptions(95).chromaSubsampling).toBe('4:4:4');
  });

  it('uses a palette for PNG below the high levels and full colour above', () => {
    expect(pngOptions(50).palette).toBe(true);
    expect(pngOptions(75).palette).toBe(true);
    expect(pngOptions(85).palette).toBe(false);
    expect(pngOptions(95).palette).toBe(false);
  });

  it('always uses maximum PNG deflate, since encoding is paid once', () => {
    for (const level of QUALITY_LEVELS) {
      expect(pngOptions(level).compressionLevel).toBe(9);
    }
  });

  it('routes each format to its own option builder', () => {
    expect(encoderOptionsFor('jpeg', 75)).toEqual(jpegOptions(75));
    expect(encoderOptionsFor('webp', 75)).toEqual(webpOptions(75));
    expect(encoderOptionsFor('png', 75)).toEqual(pngOptions(75));
    expect(encoderOptionsFor('avif', 75, 640)).toEqual(avifOptions(75, 640));
  });
});

describe('quality level coverage', () => {
  it('has an entry for each level with no gaps', () => {
    const levels: QualityLevel[] = [...QUALITY_LEVELS];
    expect(levels).toEqual([50, 65, 75, 85, 95]);
  });
});
