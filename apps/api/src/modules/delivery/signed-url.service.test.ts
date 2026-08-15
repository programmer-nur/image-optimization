import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@imgopt/config';
import { SignedUrlService } from './signed-url.service.js';

/** CloudFront requires RSA-2048 for signing keys. */
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function service(overrides: Partial<AppConfig['delivery']> = {}): SignedUrlService {
  return new SignedUrlService({
    delivery: {
      cdnHost: 'cdn.example.com',
      encoderEpoch: 1,
      signedUrlTtlSeconds: 300,
      ...overrides,
    },
  } as AppConfig);
}

const configured = () =>
  service({ signedUrlKeyPairId: 'K123456789', signedUrlPrivateKey: privateKey });

describe('when signing is not configured', () => {
  it('reports itself disabled', () => {
    expect(service().enabled).toBe(false);
  });

  it('throws rather than returning an unsigned URL', () => {
    // A silent fallback would return a URL that *works* — the public behavior would
    // serve it — so the asset would be public while the call reported success.
    expect(() => service().sign('https://cdn.example.com/p/abc/v1-1?w=640')).toThrow(
      /not configured/,
    );
  });

  it('names both halves of the configuration in the error', () => {
    expect(() => service().sign('https://cdn.example.com/p/abc/v1-1')).toThrow(
      /PRIVATE_DELIVERY_PUBLIC_KEY/,
    );
  });

  it('stays disabled with only half the key pair', () => {
    expect(service({ signedUrlKeyPairId: 'K123' }).enabled).toBe(false);
    expect(service({ signedUrlPrivateKey: privateKey }).enabled).toBe(false);
  });
});

describe('signing', () => {
  it('produces a signature, an expiry, and the key pair id', () => {
    const signed = configured().sign('https://cdn.example.com/p/abc/v1-1?w=640');

    expect(signed).toContain('Signature=');
    expect(signed).toContain('Key-Pair-Id=K123456789');
    expect(signed).toContain('Expires=');
  });

  it('uses the signature-required path prefix', () => {
    // CloudFront decides a signature is needed by path pattern; it knows nothing
    // about our metadata, so privacy has to be expressed in the URL.
    expect(configured().privateBaseUrl('abc123', 3)).toBe('https://cdn.example.com/p/abc123/v3-1');
  });

  it('covers the query string, so a viewer cannot change the transform', () => {
    // Each rendition of a private asset needs its own signature; otherwise a signed
    // link to a thumbnail would unlock every size.
    const a = configured().signForAsset('abc', 1, 'w=640');
    const b = configured().signForAsset('abc', 1, 'w=1920');

    const sigOf = (url: string) => /Signature=([^&]+)/.exec(url)?.[1];
    expect(sigOf(a)).not.toBe(sigOf(b));
  });

  it('accepts a PEM whose newlines survived as literal backslash-n', () => {
    // How a PEM almost always arrives through an environment variable. Unhandled,
    // the signer fails with an opaque parse error at the first signature.
    const escaped = service({
      signedUrlKeyPairId: 'K123456789',
      signedUrlPrivateKey: privateKey.replace(/\n/g, '\\n'),
    });

    expect(() => escaped.sign('https://cdn.example.com/p/abc/v1-1')).not.toThrow();
  });

  it('honours an explicit expiry', () => {
    const soon = configured().sign('https://cdn.example.com/p/abc/v1-1', {
      expiresInSeconds: 60,
    });
    const later = configured().sign('https://cdn.example.com/p/abc/v1-1', {
      expiresInSeconds: 3600,
    });

    const expiryOf = (url: string) => Number(/Expires=(\d+)/.exec(url)?.[1]);
    expect(expiryOf(later)).toBeGreaterThan(expiryOf(soon));
  });
});
