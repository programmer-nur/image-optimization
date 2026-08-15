import { describe, expect, it } from 'vitest';
import { DEVICE_WIDTHS, ICON_WIDTHS } from '@imgopt/core';
import { createNextLoader, isLadderWidth, nextImageSizes } from './loader.js';

const loader = createNextLoader({ cdnHost: 'cdn.example.com', encoderEpoch: 1 });

describe('next loader', () => {
  it('routes to the service CDN, not the application server', () => {
    // The point of the custom loader: next/image keeps its layout and lazy loading,
    // but the optimization never runs in the Next.js function.
    expect(loader({ src: '/i/abc123/v3-1/hero', width: 828 })).toBe(
      'https://cdn.example.com/i/abc123/v3-1/hero?w=828',
    );
  });

  it('passes quality through when Next supplies one', () => {
    expect(loader({ src: '/i/abc/v1-1', width: 640, quality: 85 })).toBe(
      'https://cdn.example.com/i/abc/v1-1?w=640&q=85',
    );
  });

  it('leaves an absolute URL alone', () => {
    expect(loader({ src: 'https://other.example.com/i/abc/v1-1', width: 320 })).toBe(
      'https://other.example.com/i/abc/v1-1?w=320',
    );
  });

  it('applies a configured base path', () => {
    const scoped = createNextLoader({
      cdnHost: 'cdn.example.com',
      encoderEpoch: 1,
      basePath: '/media',
    });

    expect(scoped({ src: '/i/abc/v1-1', width: 640 })).toBe(
      'https://cdn.example.com/media/i/abc/v1-1?w=640',
    );
  });

  it('still produces a working URL for a width off the ladder', () => {
    // Next's defaults include widths like 384 and 1200. The service snaps them, so
    // nothing breaks — the mismatch is in the descriptor, which is why the config
    // below exists.
    expect(loader({ src: '/i/abc/v1-1', width: 384 })).toContain('w=384');
  });
});

describe('exported next.config sizes', () => {
  it('draws every configured width from the ladder', () => {
    // A width Next asks for that is not a bucket means the srcset descriptor and the
    // object's real width disagree, so the browser chooses using a wrong number.
    for (const width of [...nextImageSizes.deviceSizes, ...nextImageSizes.imageSizes]) {
      expect(isLadderWidth(width), `${width} is not a ladder rung`).toBe(true);
    }
  });

  it('splits device and icon widths the way Next uses them', () => {
    expect(nextImageSizes.deviceSizes).toEqual([...DEVICE_WIDTHS]);
    expect(nextImageSizes.imageSizes).toEqual([...ICON_WIDTHS]);
  });

  it('rejects a width off the ladder', () => {
    expect(isLadderWidth(384)).toBe(false);
    expect(isLadderWidth(640)).toBe(true);
  });
});
