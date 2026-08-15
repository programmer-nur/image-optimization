import { describe, expect, it } from 'vitest';
import { LADDER } from '@imgopt/core';
import type { AppConfig } from '@imgopt/config';
import { DeliveryService } from './delivery.service.js';

function service(cdnHost = 'cdn.example.com', encoderEpoch = 1): DeliveryService {
  return new DeliveryService({
    delivery: { cdnHost, encoderEpoch },
  } as AppConfig);
}

describe('baseUrl', () => {
  it('embeds the asset id and the version-epoch segment', () => {
    expect(service().baseUrl('img_abc', 3)).toBe('https://cdn.example.com/i/img_abc/v3-1');
  });

  it('bumps the URL space when the encoder epoch changes', () => {
    expect(service('cdn.example.com', 1).baseUrl('img_abc', 3)).not.toBe(
      service('cdn.example.com', 2).baseUrl('img_abc', 3),
    );
  });

  it('uses http for localhost so local development works without TLS', () => {
    expect(service('localhost:3000').baseUrl('img_abc', 1)).toMatch(/^http:\/\/localhost:3000/);
  });

  it('encodes a slug', () => {
    expect(service().baseUrl('img_abc', 1, 'red shoes/v2')).toContain('red%20shoes%2Fv2');
  });
});

describe('srcset', () => {
  it('draws every candidate from the ladder', () => {
    const srcset = service().srcset('img_abc', 1);
    const widths = srcset.split(', ').map((c) => Number(c.split(' ')[1]!.replace('w', '')));

    for (const w of widths) expect(LADDER).toContain(w);
    expect(widths).toEqual([...LADDER]);
  });

  it('caps candidates at the source width, so none is an upscale', () => {
    const srcset = service().srcset('img_abc', 1, 1000);
    const widths = srcset.split(', ').map((c) => Number(c.split(' ')[1]!.replace('w', '')));

    expect(Math.max(...widths)).toBeLessThanOrEqual(1000);
    expect(widths.every((w) => LADDER.includes(w))).toBe(true);
  });

  it('offers the native width when the source is below the smallest rung', () => {
    const srcset = service().srcset('img_abc', 1, 10);
    expect(srcset).toContain('w=10 10w');
  });

  it('formats candidates as URL + width descriptor', () => {
    const first = service().srcset('img_abc', 2).split(', ')[0]!;
    expect(first).toMatch(/^https:\/\/cdn\.example\.com\/i\/img_abc\/v2-1\?w=\d+ \d+w$/);
  });
});
