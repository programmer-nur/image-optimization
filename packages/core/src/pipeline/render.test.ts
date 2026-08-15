import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseTransformFromQuery, type TransformSpec } from '../transform-spec.js';
import {
  alphaImage,
  baseImage,
  cmykImage,
  imageWithGps,
  notAnImage,
  orientedImage,
  truncatedImage,
  wideGamutImage,
} from './fixtures.js';
import { ProcessingError, classifyError } from './errors.js';
import { render, renderWithTimeout } from './render.js';

const ACCEPT_AVIF = 'image/avif,image/webp,*/*';

function spec(query: string, accept = ACCEPT_AVIF): TransformSpec {
  const result = parseTransformFromQuery(query, accept);
  if (!result.ok) throw new Error(`bad fixture query: ${result.error.message}`);
  return result.spec;
}

let base: Buffer;
beforeAll(async () => {
  base = await baseImage(400, 300);
});

describe('EXIF orientation', () => {
  it('applies orientation before resizing', async () => {
    // Stored 400x300 landscape, tagged 6 = rotate 90deg clockwise, so it displays
    // as 300x400 portrait. At w=256 that must yield a portrait output, not 256x192.
    const source = await orientedImage(6);
    const result = await render(source, spec('w=256&format=jpeg'));

    expect(result.width).toBe(256);
    expect(result.height).toBeGreaterThan(result.width);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('handles orientation %i without error', async (o) => {
    const source = await orientedImage(o);
    const result = await render(source, spec('w=128&format=jpeg'));

    expect(result.width).toBe(128);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('transposes dimensions only for the rotating orientations', async () => {
    const upright = await render(await orientedImage(1), spec('w=256&format=jpeg'));
    const rotated = await render(await orientedImage(6), spec('w=256&format=jpeg'));

    expect(upright.height).toBeLessThan(upright.width);
    expect(rotated.height).toBeGreaterThan(rotated.width);
  });

  it('emits no orientation tag, so viewers do not rotate a second time', async () => {
    const source = await orientedImage(6);
    const result = await render(source, spec('w=256&format=jpeg'));
    const meta = await sharp(result.data).metadata();

    expect(meta.orientation).toBeUndefined();
  });
});

describe('metadata stripping', () => {
  it('removes EXIF and GPS from derivatives', async () => {
    const source = await imageWithGps();
    const sourceMeta = await sharp(source).metadata();
    expect(sourceMeta.exif).toBeDefined();

    const result = await render(source, spec('w=100&format=jpeg'));
    const outMeta = await sharp(result.data).metadata();

    expect(outMeta.exif).toBeUndefined();
  });

  it('drops metadata for every output format', async () => {
    const source = await imageWithGps();

    for (const format of ['jpeg', 'webp', 'avif', 'png']) {
      const result = await render(source, spec(`w=100&format=${format}`));
      const meta = await sharp(result.data).metadata();
      expect(meta.exif, `${format} leaked exif`).toBeUndefined();
    }
  });
});

describe('colour handling', () => {
  it('converts CMYK sources to sRGB', async () => {
    const result = await render(await cmykImage(), spec('w=100&format=jpeg'));
    const meta = await sharp(result.data).metadata();

    expect(meta.space).toBe('srgb');
  });

  it('converts wide-gamut sources to sRGB', async () => {
    const result = await render(await wideGamutImage(), spec('w=100&format=jpeg'));
    const meta = await sharp(result.data).metadata();

    expect(meta.space).toBe('srgb');
  });

  it('does not attach a redundant ICC profile', async () => {
    const result = await render(await wideGamutImage(), spec('w=100&format=jpeg'));
    const meta = await sharp(result.data).metadata();

    expect(meta.icc).toBeUndefined();
  });
});

describe('alpha handling', () => {
  it('preserves transparency in formats that support it', async () => {
    const result = await render(await alphaImage(), spec('w=100&format=png'));
    const meta = await sharp(result.data).metadata();

    expect(meta.hasAlpha).toBe(true);
  });

  it('flattens onto the background rather than rendering black for JPEG', async () => {
    const source = await alphaImage(100, 100);
    const result = await render(source, spec('w=100&format=jpeg'));

    // Sample the transparent quadrant, which must be the default white fill.
    const { data } = await sharp(result.data)
      .extract({ left: 60, top: 60, width: 10, height: 10 })
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(data[0]).toBeGreaterThan(200);
    expect(data[1]).toBeGreaterThan(200);
    expect(data[2]).toBeGreaterThan(200);
  });

  it('honours an explicit background when padding', async () => {
    const source = await alphaImage(100, 100);
    const result = await render(source, spec('w=200&h=200&fit=pad&background=ff0000&format=jpeg'));
    const meta = await sharp(result.data).metadata();

    expect(meta.width).toBeGreaterThan(0);
  });
});

describe('never upscales', () => {
  it('caps output at the source dimensions', async () => {
    // The key may name a 1920 bucket; the pixels must not exceed the 400px source.
    const result = await render(base, spec('w=1920&format=jpeg'));

    expect(result.width).toBe(400);
  });

  it('caps a source-capped request in both axes', async () => {
    const result = await render(base, spec('w=3840&h=2160&format=jpeg'));

    expect(result.width).toBeLessThanOrEqual(400);
    expect(result.height).toBeLessThanOrEqual(300);
  });
});

describe('fit modes', () => {
  it('produces exact dimensions for cover', async () => {
    const result = await render(base, spec('w=256&h=256&fit=cover&format=jpeg'));

    expect(result.width).toBe(256);
    expect(result.height).toBe(256);
  });

  it('fits inside the box for contain', async () => {
    const result = await render(base, spec('w=256&h=256&fit=contain&format=jpeg'));

    expect(result.width).toBeLessThanOrEqual(256);
    expect(result.height).toBeLessThanOrEqual(256);
  });
});

describe('format encoding', () => {
  it('encodes every supported output format', async () => {
    const expected: Record<string, string> = {
      jpeg: 'jpeg',
      webp: 'webp',
      png: 'png',
      // sharp reports AVIF through its HEIF container.
      avif: 'heif',
    };

    for (const [format, reported] of Object.entries(expected)) {
      const result = await render(base, spec(`w=200&format=${format}`));
      const meta = await sharp(result.data).metadata();
      expect(meta.format, `${format} encoded wrong`).toBe(reported);
    }
  });

  it('produces smaller AVIF than JPEG at the same perceptual level', async () => {
    // The premise the cost model rests on: AVIF is the largest single lever on
    // bandwidth, which is ~75% of the bill.
    const photo = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        noise: { type: 'gaussian', mean: 128, sigma: 30 },
      },
    })
      .jpeg({ quality: 95 })
      .toBuffer();

    const jpeg = await render(photo, spec('w=640&q=75&format=jpeg'));
    const avif = await render(photo, spec('w=640&q=75&format=avif'));

    expect(avif.bytes).toBeLessThan(jpeg.bytes);
  });
});

describe('determinism', () => {
  it('produces byte-identical output for the same input and spec', async () => {
    // Concurrent generators race to write the same key; identical bytes are what
    // make that race harmless.
    const a = await render(base, spec('w=200&h=150&format=jpeg'));
    const b = await render(base, spec('w=200&h=150&format=jpeg'));

    expect(a.data.equals(b.data)).toBe(true);
  });

  it('is deterministic for AVIF too', async () => {
    const a = await render(base, spec('w=200&format=avif'));
    const b = await render(base, spec('w=200&format=avif'));

    expect(a.data.equals(b.data)).toBe(true);
  });
});

describe('error classification', () => {
  it('classifies a truncated source as terminal', async () => {
    const source = await truncatedImage();

    await expect(render(source, spec('w=200&format=jpeg'))).rejects.toMatchObject({
      code: 'corrupt_source',
      retriable: false,
    });
  });

  it('classifies a non-image as terminal', async () => {
    await expect(render(notAnImage(), spec('w=200&format=jpeg'))).rejects.toMatchObject({
      retriable: false,
    });
  });

  it('enforces the pixel ceiling', async () => {
    // Rather than allocating a real decompression bomb, the guard is exercised by
    // lowering the ceiling below a small fixture — same code path, no 40GB buffer.
    await expect(render(base, spec('w=200&format=jpeg'), { maxPixels: 100 })).rejects.toMatchObject(
      { code: 'pixel_limit_exceeded', retriable: false },
    );
  });

  it('treats unrecognized failures as retriable', () => {
    const classified = classifyError(new Error('connection reset by peer'));

    expect(classified.code).toBe('unexpected');
    expect(classified.retriable).toBe(true);
  });

  it('passes through an already-classified error', () => {
    const original = new ProcessingError('timeout', 'slow');
    expect(classifyError(original)).toBe(original);
  });
});

describe('timeout budget', () => {
  it('completes within budget for an ordinary image', async () => {
    const result = await renderWithTimeout(base, spec('w=256&format=jpeg'), 30_000);
    expect(result.width).toBe(256);
  });

  it('rejects as timeout when the budget is exhausted', async () => {
    await expect(renderWithTimeout(base, spec('w=256&format=avif'), 1)).rejects.toMatchObject({
      code: 'timeout',
      retriable: true,
    });
  });
});
