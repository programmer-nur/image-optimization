import { describe, expect, it } from 'vitest';
import { createImageClient } from './client.js';
import { resolveConfig } from './config.js';

const client = createImageClient({ cdnHost: 'cdn.example.com', encoderEpoch: 1 });
const asset = { id: 'abc123', version: 3 };

describe('base URL', () => {
  it('embeds the version segment the service expects', () => {
    expect(client.base(asset)).toBe('https://cdn.example.com/i/abc123/v3-1');
  });

  it('reflects the configured encoder epoch', () => {
    const epoch2 = createImageClient({ cdnHost: 'cdn.example.com', encoderEpoch: 2 });
    expect(epoch2.base(asset)).toBe('https://cdn.example.com/i/abc123/v3-2');
  });

  it('appends the slug, which is decoration and never changes the bytes', () => {
    expect(client.base({ ...asset, slug: 'red shoes' })).toBe(
      'https://cdn.example.com/i/abc123/v3-1/red%20shoes',
    );
  });
});

describe('scheme resolution', () => {
  it('defaults to https', () => {
    expect(resolveConfig({ cdnHost: 'cdn.example.com', encoderEpoch: 1 }).origin).toBe(
      'https://cdn.example.com',
    );
  });

  it('uses http for a local stack, so development needs no ceremony', () => {
    expect(resolveConfig({ cdnHost: 'localhost:8080', encoderEpoch: 1 }).origin).toBe(
      'http://localhost:8080',
    );
  });

  it('honours an explicit scheme', () => {
    expect(resolveConfig({ cdnHost: 'http://cdn.internal', encoderEpoch: 1 }).origin).toBe(
      'http://cdn.internal',
    );
  });
});

describe('configuration is validated', () => {
  it('rejects a missing host', () => {
    expect(() => resolveConfig({ cdnHost: '', encoderEpoch: 1 })).toThrow(/cdnHost/);
  });

  it('rejects a non-integer epoch, naming what it must match', () => {
    // A wrong epoch breaks every URL at once; a silent default would look like a
    // working configuration.
    expect(() => resolveConfig({ cdnHost: 'cdn.example.com', encoderEpoch: 1.5 })).toThrow(
      /ENCODER_EPOCH/,
    );
  });
});

describe('transform parameters', () => {
  it('emits only what was asked for', () => {
    expect(client.url(asset, { width: 640 })).toBe('https://cdn.example.com/i/abc123/v3-1?w=640');
  });

  it('elides quality when it matches the service default', () => {
    // `?q=75` and no `q` normalize to the same key, so emitting it only lengthens
    // every URL on the page.
    expect(client.url(asset, { width: 640, quality: 75 })).toBe(
      'https://cdn.example.com/i/abc123/v3-1?w=640',
    );
    expect(client.url(asset, { width: 640, quality: 85 })).toBe(
      'https://cdn.example.com/i/abc123/v3-1?w=640&q=85',
    );
  });

  it('elides dpr 1 and format auto, which are both identities', () => {
    expect(client.url(asset, { width: 640, dpr: 1, format: 'auto' })).toBe(
      'https://cdn.example.com/i/abc123/v3-1?w=640',
    );
  });

  it('elides zero-level effects', () => {
    expect(client.url(asset, { width: 640, blur: 0, sharpen: 0 })).toBe(
      'https://cdn.example.com/i/abc123/v3-1?w=640',
    );
  });

  it('strips a leading hash from a background colour', () => {
    expect(client.url(asset, { width: 640, height: 640, fit: 'pad', background: '#ff0000' })).toBe(
      'https://cdn.example.com/i/abc123/v3-1?w=640&h=640&fit=pad&background=ff0000',
    );
  });

  it('emits parameters in a fixed order regardless of object key order', () => {
    // Not for the CDN, which is order-insensitive — for hydration. A server render
    // and a client render that disagree on the string make React replace the
    // element, discarding an image that may already be decoded.
    const a = client.url(asset, { width: 640, height: 360, fit: 'cover', quality: 85 });
    const b = client.url(asset, { quality: 85, fit: 'cover', height: 360, width: 640 });

    expect(a).toBe(b);
    expect(a).toBe('https://cdn.example.com/i/abc123/v3-1?w=640&h=360&q=85&fit=cover');
  });

  it('rounds fractional widths, which layout maths produces constantly', () => {
    expect(client.url(asset, { width: 640.4 })).toContain('w=640');
  });
});

describe('fromBase', () => {
  it('appends to a base URL the API produced, so the epoch cannot drift', () => {
    expect(client.fromBase('https://cdn.example.com/i/abc/v9-4/hero', { width: 828 })).toBe(
      'https://cdn.example.com/i/abc/v9-4/hero?w=828',
    );
  });

  it('preserves an existing query string', () => {
    expect(client.fromBase('https://cdn.example.com/i/abc/v1-1?x=1', { width: 320 })).toBe(
      'https://cdn.example.com/i/abc/v1-1?x=1&w=320',
    );
  });
});
