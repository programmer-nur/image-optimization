import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { alphaImage, baseImage, cmykImage, notAnImage, orientedImage } from './fixtures.js';
import {
  generateLqip,
  generateMaster,
  needsMaster,
  readDominantColor,
  readMetadata,
} from './metadata.js';

describe('readMetadata', () => {
  it('reports intrinsic properties', async () => {
    const meta = await readMetadata(await baseImage(400, 300));

    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
    expect(meta.format).toBe('jpeg');
    expect(meta.hasAlpha).toBe(false);
    expect(meta.bytes).toBeGreaterThan(0);
  });

  it('reports displayed dimensions, not stored ones', async () => {
    // Stored 400x300 with orientation 6, which viewers rotate to 300x400. Reporting
    // the stored values would give clients a transposed aspect ratio: wrong
    // width/height attributes, layout shift, and srcset capped on the wrong axis.
    const meta = await readMetadata(await orientedImage(6));

    expect(meta.width).toBe(300);
    expect(meta.height).toBe(400);
    expect(meta.orientation).toBe(6);
    expect(meta.orientationSwapsAxes).toBe(true);
  });

  it('leaves axes alone for non-rotating orientations', async () => {
    const meta = await readMetadata(await orientedImage(3));

    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
    expect(meta.orientationSwapsAxes).toBe(false);
  });

  it.each([
    [1, false],
    [2, false],
    [3, false],
    [4, false],
    [5, true],
    [6, true],
    [7, true],
    [8, true],
  ])('orientation %i swaps axes: %s', async (orientation, swaps) => {
    const meta = await readMetadata(await orientedImage(orientation));
    expect(meta.orientationSwapsAxes).toBe(swaps);
  });

  it('detects alpha', async () => {
    const meta = await readMetadata(await alphaImage());

    expect(meta.hasAlpha).toBe(true);
    expect(meta.format).toBe('png');
  });

  it('reports the source colourspace', async () => {
    const meta = await readMetadata(await cmykImage());
    expect(meta.colorspace).toBe('cmyk');
  });

  it('classifies unreadable input', async () => {
    await expect(readMetadata(notAnImage())).rejects.toMatchObject({ retriable: false });
  });
});

describe('readDominantColor', () => {
  it('returns a six-digit hex string', async () => {
    const color = await readDominantColor(await baseImage(100, 100));
    expect(color).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe('generateLqip', () => {
  it('produces a small inline data URI', async () => {
    const lqip = await generateLqip(await baseImage(1200, 900));

    expect(lqip.startsWith('data:image/webp;base64,')).toBe(true);
    // The whole point is that it ships inside the HTML. A placeholder that costs a
    // round trip is worse than no placeholder.
    expect(lqip.length).toBeLessThan(2000);
  });

  it('decodes to the requested width', async () => {
    const lqip = await generateLqip(await baseImage(1200, 900), { width: 24 });
    const bytes = Buffer.from(lqip.split(',')[1]!, 'base64');
    const meta = await sharp(bytes).metadata();

    expect(meta.width).toBe(24);
  });

  it('applies orientation so the placeholder is not transposed', async () => {
    const lqip = await generateLqip(await orientedImage(6), { width: 24 });
    const bytes = Buffer.from(lqip.split(',')[1]!, 'base64');
    const meta = await sharp(bytes).metadata();

    expect(meta.height).toBeGreaterThan(meta.width);
  });

  it('does not enlarge a tiny source', async () => {
    const lqip = await generateLqip(await baseImage(16, 12), { width: 24 });
    const bytes = Buffer.from(lqip.split(',')[1]!, 'base64');
    const meta = await sharp(bytes).metadata();

    expect(meta.width).toBe(16);
  });
});

describe('generateMaster', () => {
  it('bounds the longest edge', async () => {
    const master = await generateMaster(await baseImage(2000, 1000), { longestEdge: 800 });
    const meta = await sharp(master).metadata();

    expect(Math.max(meta.width, meta.height)).toBe(800);
  });

  it('preserves aspect ratio', async () => {
    const master = await generateMaster(await baseImage(2000, 1000), { longestEdge: 800 });
    const meta = await sharp(master).metadata();

    expect(meta.width / meta.height).toBeCloseTo(2, 1);
  });

  it('does not enlarge a source below the bound', async () => {
    const master = await generateMaster(await baseImage(400, 300), { longestEdge: 4000 });
    const meta = await sharp(master).metadata();

    expect(meta.width).toBe(400);
  });

  it('applies orientation', async () => {
    const master = await generateMaster(await orientedImage(6), { longestEdge: 200 });
    const meta = await sharp(master).metadata();

    expect(meta.height).toBeGreaterThan(meta.width);
  });
});

describe('needsMaster', () => {
  const thresholds = { bytes: 20 * 1024 * 1024, longestEdge: 4000 };

  it('is not worth it for an ordinary image', () => {
    expect(needsMaster({ width: 1200, height: 800, bytes: 900_000 }, thresholds)).toBe(false);
  });

  it('triggers on dimensions', () => {
    expect(needsMaster({ width: 12000, height: 8000, bytes: 900_000 }, thresholds)).toBe(true);
  });

  it('triggers on byte size', () => {
    expect(needsMaster({ width: 1200, height: 800, bytes: 30 * 1024 * 1024 }, thresholds)).toBe(
      true,
    );
  });

  it('triggers exactly at the boundary crossing, not on it', () => {
    expect(needsMaster({ width: 4000, height: 100, bytes: 1000 }, thresholds)).toBe(false);
    expect(needsMaster({ width: 4001, height: 100, bytes: 1000 }, thresholds)).toBe(true);
  });
});
