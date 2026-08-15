/**
 * Upload helpers for both ingest modes.
 *
 * Two modes exist because they solve different problems, and picking the wrong one
 * is the usual integration mistake (see design.md D2):
 *
 * - **Proxied** — one multipart request to the control plane, which streams it into
 *   staging. Simple, but the bytes cross the application server.
 * - **Presigned** — the client asks for a target, uploads straight to storage, then
 *   calls complete. The bytes never touch the control plane, which is what makes
 *   large files survivable, but it is three round trips.
 *
 * `upload()` chooses by size against the deployment's own threshold, so callers do
 * not have to know which one they are on.
 *
 * Uses `fetch` and `XMLHttpRequest` only — no Node-only APIs — so this runs in a
 * browser and in any modern server runtime.
 */

import type { ImageAsset } from './types.js';

export interface UploadClientConfig {
  /** Control-plane origin, e.g. `https://api.example.com`. */
  apiUrl: string;
  /**
   * Sent as `Authorization: Bearer`.
   *
   * Only pass this in a browser if the key is scoped to uploads and you accept that
   * it is public. The presigned flow exists partly so a server can hold the key and
   * hand out short-lived targets instead.
   */
  apiKey?: string;
  /**
   * Above this, the presigned flow is used. Must not exceed the deployment's
   * `UPLOAD_PROXY_THRESHOLD_BYTES`, or the proxied endpoint answers 413.
   */
  proxyThresholdBytes?: number;
  fetch?: typeof globalThis.fetch;
}

export interface UploadMetadata {
  altText?: string;
  tags?: string[];
}

export interface UploadOptions extends UploadMetadata {
  contentType: string;
  filename?: string;
  /** Fraction between 0 and 1. Only reported for the presigned flow. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface UploadResult {
  asset: ImageAsset;
  /** True when the content hash matched an existing asset and nothing was stored. */
  duplicate: boolean;
  mode: 'proxied' | 'presigned';
}

/** Default proxy threshold, matching `packages/config`. */
export const DEFAULT_PROXY_THRESHOLD_BYTES = 10 * 1024 * 1024;

interface PresignedTarget {
  assetId: string;
  upload: { url: string; fields: Record<string, string>; key: string; expiresAt: string };
}

export class UploadError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = 'upload_failed') {
    super(message);
    this.name = 'UploadError';
    this.status = status;
    this.code = code;
  }
}

export class UploadClient {
  private readonly apiUrl: string;
  private readonly proxyThreshold: number;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(private readonly config: UploadClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, '');
    this.proxyThreshold = config.proxyThresholdBytes ?? DEFAULT_PROXY_THRESHOLD_BYTES;
    // Bound, because an unbound `fetch` throws "Illegal invocation" in browsers.
    this.doFetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Picks the mode by size. Prefer this over calling either mode directly. */
  async upload(file: Blob, options: UploadOptions): Promise<UploadResult> {
    return file.size > this.proxyThreshold
      ? this.uploadPresigned(file, options)
      : this.uploadProxied(file, options);
  }

  /** One multipart request. The response never waits on processing. */
  async uploadProxied(file: Blob, options: UploadOptions): Promise<UploadResult> {
    const body = new FormData();
    body.append('file', file, options.filename ?? 'upload');
    if (options.altText !== undefined) body.append('altText', options.altText);
    if (options.tags !== undefined) body.append('tags', options.tags.join(','));

    const response = await this.doFetch(`${this.apiUrl}/v1/images`, {
      method: 'POST',
      headers: this.authHeaders(),
      body,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    const result = await this.parse<{ asset: ImageAsset; duplicate: boolean }>(response);
    return { ...result, mode: 'proxied' };
  }

  /**
   * Three steps: ask for a target, PUT the bytes at storage, then complete.
   *
   * Only the completion step validates — magic bytes, dimensions, quota — because a
   * direct-to-storage upload physically cannot be checked before it is stored. That
   * is what the staging prefix is for: nothing under it is CDN-reachable, and it
   * expires by lifecycle policy whether or not completion is ever called.
   */
  async uploadPresigned(file: Blob, options: UploadOptions): Promise<UploadResult> {
    const target = await this.parse<PresignedTarget>(
      await this.doFetch(`${this.apiUrl}/v1/images/uploads`, {
        method: 'POST',
        headers: { ...this.authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({
          contentType: options.contentType,
          ...(options.altText !== undefined ? { altText: options.altText } : {}),
          ...(options.tags !== undefined ? { tags: options.tags } : {}),
        }),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      }),
    );

    await this.putToStorage(file, target, options);

    const result = await this.parse<{ asset: ImageAsset; duplicate: boolean }>(
      await this.doFetch(`${this.apiUrl}/v1/images/uploads/${target.assetId}/complete`, {
        method: 'POST',
        headers: { ...this.authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ contentType: options.contentType }),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      }),
    );

    return { ...result, mode: 'presigned' };
  }

  /**
   * Sends the bytes to storage.
   *
   * `XMLHttpRequest` rather than `fetch`, solely for upload progress: `fetch` still
   * has no portable way to observe request-body progress, and progress is the whole
   * point of the presigned flow from a browser. Falls back to `fetch` when XHR is
   * absent (a server runtime) or no progress callback was given.
   */
  private async putToStorage(
    file: Blob,
    target: PresignedTarget,
    options: UploadOptions,
  ): Promise<void> {
    const form = new FormData();
    for (const [key, value] of Object.entries(target.upload.fields)) form.append(key, value);
    // Must be last: S3 ignores every field after the file part.
    form.append('file', file, options.filename ?? 'upload');

    const wantsProgress = options.onProgress !== undefined && typeof XMLHttpRequest !== 'undefined';

    if (!wantsProgress) {
      const response = await this.doFetch(target.upload.url, {
        method: 'POST',
        body: form,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (!response.ok) {
        throw new UploadError(
          `Storage rejected the upload (${response.status}).`,
          response.status,
          'storage_rejected',
        );
      }
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', target.upload.url);

      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
      });
      request.addEventListener('load', () => {
        if (request.status >= 200 && request.status < 300) {
          options.onProgress?.(1);
          resolve();
          return;
        }
        reject(
          new UploadError(
            `Storage rejected the upload (${request.status}).`,
            request.status,
            'storage_rejected',
          ),
        );
      });
      request.addEventListener('error', () =>
        reject(new UploadError('Network error during upload.', 0, 'network_error')),
      );
      request.addEventListener('abort', () =>
        reject(new UploadError('Upload aborted.', 0, 'aborted')),
      );

      options.signal?.addEventListener('abort', () => {
        request.abort();
      });

      request.send(form);
    });
  }

  private authHeaders(): Record<string, string> {
    return this.config.apiKey === undefined
      ? {}
      : { authorization: `Bearer ${this.config.apiKey}` };
  }

  /** Surfaces the API's `{ error: { code, message } }` envelope rather than a status. */
  private async parse<T>(response: Response): Promise<T> {
    if (response.ok) return (await response.json()) as T;

    let code = 'upload_failed';
    let message = `Request failed with ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code !== undefined) code = body.error.code;
      if (body.error?.message !== undefined) message = body.error.message;
    } catch {
      // Not every failure is JSON — a proxy timeout or an ALB error page is not.
    }

    throw new UploadError(message, response.status, code);
  }
}
