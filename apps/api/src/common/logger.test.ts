/**
 * Redaction tests.
 *
 * A credential in a log line is a credential in log storage, shipped wherever logs
 * go and retained long after anyone remembers the key existed. These assert the
 * shapes this service actually emits, not a generic list — each one corresponds to
 * a real object that passes through a handler.
 */

import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

/**
 * Captures one line from the real logger.
 *
 * Built through `createLogger` on purpose: a second pino instance configured in the
 * test would assert the test's own redact list, not the one the service ships.
 */
function logLine(payload: Record<string, unknown>): string {
  const chunks: string[] = [];
  const logger = createLogger('info', { write: (chunk: string) => chunks.push(chunk) });

  logger.info(payload, 'test');
  return chunks.join('');
}

describe('the capture helper actually captures', () => {
  it('lets an unredacted value through', () => {
    // Without this, every `not.toContain` below would pass against an empty string
    // and the whole suite would be decorative.
    expect(logLine({ harmless: 'visible-value' })).toContain('visible-value');
  });
});

describe('credential redaction', () => {
  it('censors an inbound API key header', () => {
    const line = logLine({ req: { headers: { 'x-api-key': 'imgk_key_01_supersecret' } } });

    expect(line).not.toContain('supersecret');
    expect(line).toContain('[redacted]');
  });

  it('censors a bearer token', () => {
    expect(
      logLine({ req: { headers: { authorization: 'Bearer imgk_key_01_abc' } } }),
    ).not.toContain('imgk_key_01_abc');
  });

  it('censors presigned upload fields, which are a working credential together', () => {
    // Policy plus signature is an upload credential for the staging prefix, and it
    // travels through the API as ordinary response data.
    const line = logLine({
      target: {
        upload: {
          url: 'https://bucket.s3.amazonaws.com',
          fields: { Policy: 'eyJleHBpcmF0aW9u', 'X-Amz-Signature': 'deadbeefcafe' },
        },
      },
    });

    expect(line).not.toContain('deadbeefcafe');
    expect(line).not.toContain('eyJleHBpcmF0aW9u');
  });

  it('censors a freshly issued key plaintext', () => {
    expect(logLine({ result: { plaintext: 'imgk_key_02_neverlogthis' } })).not.toContain(
      'neverlogthis',
    );
  });

  it('censors a stored key hash', () => {
    expect(logLine({ apiKey: { hash: 'a'.repeat(64) } })).not.toContain('a'.repeat(64));
  });

  it('censors a database password', () => {
    expect(logLine({ db: { password: 'hunter2' } })).not.toContain('hunter2');
  });

  it('still emits the surrounding context, so logs stay useful', () => {
    const line = logLine({ assetId: 'abc123', req: { headers: { 'x-api-key': 'secret' } } });

    expect(line).toContain('abc123');
    expect(line).toContain('test');
  });
});
