/**
 * The two properties the SDK exists to guarantee (task 10.10).
 *
 * A hand-written `srcset` drifts off the ladder within about a week, and nothing
 * fails when it does: the edge snaps the width, the image looks right, and the only
 * evidence is a cache-miss rate that never settles and a generation bill that tracks
 * traffic instead of assets. These assertions are the tripwire.
 */

import { describe, expect, it } from 'vitest';
import { DEVICE_WIDTHS, LADDER } from '@imgopt/core';
import { createImageClient } from './client.js';
import { candidateWidths, defaultWidth, sizes } from './srcset.js';
import type { ImageAsset } from './types.js';

const client = createImageClient({ cdnHost: 'cdn.example.com', encoderEpoch: 1 });
const asset = { id: 'abc123', version: 3 };

/** Pulls the `w` parameter and the descriptor out of each candidate. */
function parseCandidates(srcset: string): Array<{ url: number; descriptor: number }> {
  return srcset.split(', ').map((candidate) => {
    const [url, descriptor] = candidate.split(' ');
    const width = /[?&]w=(\d+)/.exec(url!);

    return {
      url: width === null ? Number.NaN : Number(width[1]),
      descriptor: Number(descriptor!.replace('w', '')),
    };
  });
}

describe('every candidate width is on the ladder', () => {
  it.each([undefined, 500, 1000, 3000, 5000, 16, 15])(
    'holds for a source width of %s',
    (sourceWidth) => {
      const srcset = client.srcset(asset, {
        ...(sourceWidth !== undefined ? { sourceWidth } : {}),
      });

      for (const { url } of parseCandidates(srcset)) {
        // The one exception is a source narrower than the smallest rung, which gets
        // its own width — 12 pixels has no sensible bucket.
        const allowed = LADDER.includes(url) || url === sourceWidth;
        expect(allowed, `width ${url} is not a ladder rung`).toBe(true);
      }
    },
  );

  it.each(['100vw', '50vw', '48px', '(max-width: 640px) 100vw, 33vw'])(
    'holds for sizes %s',
    (sizesValue) => {
      const srcset = client.srcset(asset, {
        sourceWidth: 2000,
        sizes: sizesValue,
        width: 96,
      });

      for (const { url } of parseCandidates(srcset)) {
        expect(LADDER.includes(url), `width ${url} is not a ladder rung`).toBe(true);
      }
    },
  );

  it('advertises the width it actually requests', () => {
    // If these diverge the browser picks a candidate using a number that is not what
    // the object holds, which is worse than picking badly.
    for (const { url, descriptor } of parseCandidates(
      client.srcset(asset, { sourceWidth: 3000 }),
    )) {
      expect(url).toBe(descriptor);
    }
  });
});

describe('no candidate exceeds the source width', () => {
  it.each([500, 1000, 2000, 3000, 4000])('holds for a %spx source', (sourceWidth) => {
    for (const { url } of parseCandidates(client.srcset(asset, { sourceWidth }))) {
      expect(url).toBeLessThanOrEqual(sourceWidth);
    }
  });

  it('stops at the largest rung below the source', () => {
    // 500 sits between 480 and 640; 640 would be an upscale the edge cannot decline,
    // because it has no idea how wide the source is.
    const widths = candidateWidths({ sourceWidth: 500 });
    expect(widths[widths.length - 1]).toBe(480);
  });

  it('offers the smallest rung when the source is smaller than every rung', () => {
    // Not the native 12: the edge snaps every requested width up to a rung, so a
    // `12w` candidate would advertise a width the delivered bytes never have and
    // name a key the generator refuses. `withoutEnlargement` still delivers 12px.
    expect(candidateWidths({ sourceWidth: 12 })).toEqual([16]);
  });

  it('respects an explicit width list, still capped at the source', () => {
    expect(candidateWidths({ sourceWidth: 1000, widths: [320, 640, 1920] })).toEqual([320, 640]);
  });
});

describe('candidate set is chosen by how the image renders', () => {
  it('offers only device rungs for a viewport-scaled image', () => {
    // The icon rungs cannot be selected when the image spans a fraction of the
    // viewport, and every candidate offered is a variant some browser may cause to
    // be generated and stored. Offering `16w` on a hero is not merely dead markup.
    const widths = candidateWidths({ sourceWidth: 3000, sizes: '100vw' });

    expect(widths).toEqual([...DEVICE_WIDTHS].filter((w) => w <= 3000));
    expect(widths).not.toContain(16);
  });

  it('treats an absent sizes as responsive, matching the browser default', () => {
    expect(candidateWidths({ sourceWidth: 3000 })).toEqual(
      [...DEVICE_WIDTHS].filter((w) => w <= 3000),
    );
  });

  it('recognizes a viewport fraction anywhere in a media-query list', () => {
    const widths = candidateWidths({
      sourceWidth: 3000,
      sizes: '(max-width: 640px) 100vw, 33vw',
    });
    expect(widths).not.toContain(16);
  });

  it('offers 1x and 2x rungs for a fixed-size image', () => {
    // This is where the icon ladder earns its place: a 48px avatar gets 48 and 96,
    // not a 320px minimum that would ship roughly forty times the bytes.
    expect(candidateWidths({ sourceWidth: 512, sizes: '48px', targetWidth: 48 })).toEqual([48, 96]);
  });

  it('caps a fixed-size candidate set at the source', () => {
    expect(candidateWidths({ sourceWidth: 12, sizes: '48px', targetWidth: 48 })).toEqual([16]);
  });

  it('collapses to one candidate when 1x and 2x share a rung', () => {
    // 1x -> 3840 (clamped) and 2x -> 3840; a duplicate descriptor is invalid markup.
    const widths = candidateWidths({ sizes: '3000px', targetWidth: 3000 });
    expect(new Set(widths).size).toBe(widths.length);
  });
});

describe('defaultWidth', () => {
  it('picks a plausible rendering width, not the largest available', () => {
    // `src` is a fallback, not the biggest thing on offer; a 4000px source should
    // not hand a non-srcset browser a 3840px file.
    expect(defaultWidth(4000)).toBe(1080);
  });

  it('never exceeds the source, and never leaves the ladder', () => {
    expect(defaultWidth(500)).toBe(480);
    // A sub-rung source still resolves to a rung — every width in a URL is one.
    expect(defaultWidth(12)).toBe(16);
  });
});

describe('sizes', () => {
  it('passes a string through unchanged', () => {
    expect(sizes('100vw')).toBe('100vw');
  });

  it('joins media conditions in order with a bare fallback last', () => {
    expect(
      sizes([
        ['(max-width: 768px)', '100vw'],
        ['(max-width: 1200px)', '50vw'],
        ['', '33vw'],
      ]),
    ).toBe('(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw');
  });
});

describe('forAsset', () => {
  const ready: ImageAsset = {
    id: 'abc123',
    status: 'ready',
    version: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    altText: 'A green field',
    tags: [],
    focalPoint: null,
    failureReason: null,
    source: {
      width: 2000,
      height: 1125,
      format: 'jpeg',
      bytes: '482915',
      hasAlpha: false,
      dominantColor: '#5a8c3c',
    },
    lqip: 'data:image/webp;base64,AAAA',
    urls: { base: '', src: '', srcset: '' },
  };

  it('caps candidates at the intrinsic width read off the asset', () => {
    const image = client.forAsset(ready)!;

    for (const { url } of parseCandidates(image.srcset)) {
      expect(url).toBeLessThanOrEqual(2000);
    }
  });

  it('carries the intrinsic dimensions through for layout reservation', () => {
    const image = client.forAsset(ready)!;
    expect(image.width).toBe(2000);
    expect(image.height).toBe(1125);
  });

  it('returns null for an asset that cannot be rendered yet', () => {
    expect(client.forAsset({ ...ready, urls: null })).toBeNull();
  });
});

describe('a pinned crop keeps its shape across candidates', () => {
  it('scales height with width so every candidate is the same ratio', () => {
    // Carrying `h` unchanged onto every candidate asks for a different aspect ratio
    // at every breakpoint — a portrait 320x800 where a 3:2 landscape was intended.
    // It still fills its box, so nothing looks broken until the mobile crop is
    // noticed, and each wrong ratio is its own cache key and its own generation.
    const srcset = client.srcset(asset, {
      width: 1200,
      height: 800,
      fit: 'cover',
      sourceWidth: 2400,
      sizes: '33vw',
    });

    for (const candidate of srcset.split(', ')) {
      const w = Number(/[?&]w=(\d+)/.exec(candidate)![1]);
      const h = Number(/[?&]h=(\d+)/.exec(candidate)![1]);

      expect(Math.abs(h / w - 800 / 1200)).toBeLessThan(0.01);
    }
  });

  it('leaves a width-only transform without a height', () => {
    expect(client.srcset(asset, { width: 1200, sourceWidth: 2400 })).not.toContain('h=');
  });
});
