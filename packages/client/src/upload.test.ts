/**
 * Upload helper tests against a stubbed `fetch`.
 *
 * The interesting behaviour is the flow — which endpoints are called, in what order,
 * and how mode is chosen — not the transport. The real transport is covered by the
 * API's own e2e suite against MinIO.
 */

import { describe, expect, it, vi } from 'vitest';
import { UploadClient, UploadError } from './upload.js';
import type { ImageAsset } from './types.js';

const asset = { id: 'abc123', status: 'stored', version: 1 } as unknown as ImageAsset;

/** `RequestInfo | URL` has three shapes and only one of them stringifies usefully. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Records every call and answers each endpoint the flows touch. */
function stubFetch() {
  const calls: Array<{ url: string; method: string }> = [];
  const respond = (body: unknown, status = 200): Promise<Response> =>
    Promise.resolve(jsonResponse(body, status));

  const doFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push({ url, method: init?.method ?? 'GET' });

    if (url.endsWith('/v1/images')) return respond({ asset, duplicate: false });
    if (url.endsWith('/v1/images/uploads')) {
      return respond({
        assetId: 'abc123',
        upload: {
          url: 'https://storage.example.com/bucket',
          fields: { key: 'staging/abc123', policy: 'x' },
          key: 'staging/abc123',
          expiresAt: '2026-01-01T00:00:00.000Z',
        },
      });
    }
    if (url.includes('/complete')) return respond({ asset, duplicate: false });
    if (url.startsWith('https://storage.example.com')) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    return respond({ error: { code: 'not_found', message: 'no route' } }, 404);
  });

  return { doFetch, calls };
}

describe('mode selection', () => {
  it('proxies a small file in a single request', async () => {
    const { doFetch, calls } = stubFetch();
    const client = new UploadClient({ apiUrl: 'https://api.example.com', fetch: doFetch });

    const result = await client.upload(new Blob(['x'.repeat(1024)]), {
      contentType: 'image/jpeg',
    });

    expect(result.mode).toBe('proxied');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.example.com/v1/images');
  });

  it('sends a large file straight to storage, never through the control plane', async () => {
    const { doFetch, calls } = stubFetch();
    const client = new UploadClient({
      apiUrl: 'https://api.example.com',
      fetch: doFetch,
      proxyThresholdBytes: 1024,
    });

    const result = await client.upload(new Blob(['x'.repeat(4096)]), {
      contentType: 'image/jpeg',
    });

    expect(result.mode).toBe('presigned');
    // Target, then storage, then complete — and the bytes only ever go to storage.
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.example.com/v1/images/uploads',
      'https://storage.example.com/bucket',
      'https://api.example.com/v1/images/uploads/abc123/complete',
    ]);
  });

  it('respects the threshold boundary exactly', async () => {
    const { doFetch } = stubFetch();
    const client = new UploadClient({
      apiUrl: 'https://api.example.com',
      fetch: doFetch,
      proxyThresholdBytes: 1024,
    });

    // At the threshold, not above it.
    const result = await client.upload(new Blob(['x'.repeat(1024)]), {
      contentType: 'image/jpeg',
    });
    expect(result.mode).toBe('proxied');
  });
});

describe('authentication', () => {
  it('sends the API key to the control plane and not to storage', async () => {
    const { doFetch } = stubFetch();
    const client = new UploadClient({
      apiUrl: 'https://api.example.com',
      apiKey: 'secret-key',
      fetch: doFetch,
      proxyThresholdBytes: 1,
    });

    await client.upload(new Blob(['xx']), { contentType: 'image/jpeg' });

    const headersFor = (index: number) =>
      (doFetch.mock.calls[index]![1]?.headers ?? {}) as Record<string, string>;

    expect(headersFor(0).authorization).toBe('Bearer secret-key');
    // The presigned POST carries its own signature; sending the key would leak it to
    // the storage endpoint for no reason.
    expect(headersFor(1).authorization).toBeUndefined();
  });
});

describe('error handling', () => {
  it('surfaces the API error envelope rather than a bare status', async () => {
    const doFetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: 'unsupported_format', message: 'SVG uploads are not accepted.' } },
          400,
        ),
      ),
    );
    const client = new UploadClient({ apiUrl: 'https://api.example.com', fetch: doFetch });

    await expect(
      client.upload(new Blob(['x']), { contentType: 'image/svg+xml' }),
    ).rejects.toMatchObject({
      code: 'unsupported_format',
      message: 'SVG uploads are not accepted.',
      status: 400,
    });
  });

  it('still fails usefully when the body is not JSON', async () => {
    // A proxy timeout or a load-balancer error page is HTML, and parsing it must not
    // replace the real failure with a JSON syntax error.
    const doFetch = vi.fn(() => Promise.resolve(new Response('<html>504</html>', { status: 504 })));
    const client = new UploadClient({ apiUrl: 'https://api.example.com', fetch: doFetch });

    await expect(client.upload(new Blob(['x']), { contentType: 'image/jpeg' })).rejects.toThrow(
      UploadError,
    );
  });

  it('reports a storage rejection distinctly from an API rejection', async () => {
    const doFetch = vi.fn((input: RequestInfo | URL) => {
      if (urlOf(input).endsWith('/v1/images/uploads')) {
        return Promise.resolve(
          jsonResponse({
            assetId: 'abc123',
            upload: { url: 'https://storage.example.com/b', fields: {}, key: 'k', expiresAt: '' },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 403 }));
    });

    const client = new UploadClient({
      apiUrl: 'https://api.example.com',
      fetch: doFetch,
      proxyThresholdBytes: 0,
    });

    await expect(
      client.upload(new Blob(['x']), { contentType: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 'storage_rejected' });
  });
});

describe('presigned form', () => {
  it('appends the file last, because S3 ignores fields after it', async () => {
    const { doFetch } = stubFetch();
    const client = new UploadClient({
      apiUrl: 'https://api.example.com',
      fetch: doFetch,
      proxyThresholdBytes: 0,
    });

    await client.upload(new Blob(['x']), { contentType: 'image/jpeg' });

    const body = doFetch.mock.calls[1]![1]?.body as FormData;
    const keys = [...body.keys()];

    expect(keys[keys.length - 1]).toBe('file');
    expect(keys).toContain('policy');
  });
});
