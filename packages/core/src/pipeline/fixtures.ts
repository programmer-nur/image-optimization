/**
 * Test fixtures, generated rather than committed.
 *
 * Binary fixtures in a repo rot: nobody can see what changed in a diff, and nobody
 * remembers how they were produced. Generating them keeps the *intent* readable and
 * guarantees they match the libvips build actually in use.
 */

import sharp from 'sharp';

/** A recognizable asymmetric image, so rotation errors are visible in assertions. */
export async function baseImage(width = 400, height = 300): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 200 } },
  })
    .composite([
      {
        // A white block in the top-left quadrant. Under a wrong rotation it lands
        // somewhere else, which is what the orientation tests look for.
        input: {
          create: {
            width: Math.floor(width / 4),
            height: Math.floor(height / 4),
            channels: 3,
            background: { r: 255, g: 255, b: 255 },
          },
        },
        top: 0,
        left: 0,
      },
    ])
    .jpeg({ quality: 95 })
    .toBuffer();
}

/**
 * A landscape JPEG carrying an EXIF orientation tag.
 *
 * Orientations 5-8 instruct viewers to rotate by 90 degrees, transposing the
 * displayed axes relative to the stored ones — the case that breaks pipelines which
 * resize before rotating.
 */
export async function orientedImage(orientation: number): Promise<Buffer> {
  const base = await baseImage(400, 300);
  // Orientation must go through `withMetadata`, not `withExif`. sharp special-cases
  // the tag: writing it via `withExif({ IFD0: { Orientation } })` produces EXIF that
  // reads back as orientation 1, yielding fixtures that silently test nothing.
  return sharp(base).withMetadata({ orientation }).jpeg({ quality: 95 }).toBuffer();
}

/** PNG with a genuinely transparent region. */
export async function alphaImage(width = 200, height = 200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: {
          create: {
            width: width / 2,
            height: height / 2,
            channels: 4,
            background: { r: 0, g: 255, b: 0, alpha: 1 },
          },
        },
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();
}

/** CMYK JPEG — the colourspace that renders as garbage if converted carelessly. */
export async function cmykImage(): Promise<Buffer> {
  const base = await baseImage(200, 150);
  return sharp(base).toColorspace('cmyk').jpeg({ quality: 95 }).toBuffer();
}

/** JPEG carrying GPS coordinates, for the metadata-stripping assertions. */
export async function imageWithGps(): Promise<Buffer> {
  const base = await baseImage(200, 150);
  return sharp(base)
    .withExif({
      IFD0: { Copyright: 'Test Corp', Artist: 'Test Photographer' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '51/1 30/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 7/1 0/1',
      },
    })
    .jpeg({ quality: 95 })
    .toBuffer();
}

/** A JPEG cut off partway, to exercise `failOn: 'truncated'`. */
export async function truncatedImage(): Promise<Buffer> {
  const base = await baseImage(400, 300);
  return base.subarray(0, Math.floor(base.length * 0.4));
}

/** Bytes that are not an image at all. */
export function notAnImage(): Buffer {
  return Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\nnot an image at all', 'binary');
}

/** A static GIF. Animated GIF transcoding is explicitly out of scope. */
export async function gifImage(): Promise<Buffer> {
  const base = await baseImage(100, 100);
  return sharp(base).gif().toBuffer();
}

/** A wide-gamut source, for the sRGB conversion assertions. */
export async function wideGamutImage(): Promise<Buffer> {
  const base = await baseImage(200, 150);
  return sharp(base).withIccProfile('p3').jpeg({ quality: 95 }).toBuffer();
}
