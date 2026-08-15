/**
 * Structured logging.
 *
 * pino to stdout as JSON. A correlation id generated at ingest is bound to every log
 * line for the life of a request, so filtering by one `assetId` (or one request)
 * reconstructs the whole flow — including, once the job leaves via SQS, the work the
 * optimizer Lambda does under the same id.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger } from 'pino';

export interface RequestContext {
  correlationId: string;
  assetId?: string;
}

/** Request-scoped context, propagated without threading it through every call. */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * @param destination Optional sink. Exists so the redaction rules can be asserted
 *   against the real configuration rather than a copy of it — a second pino instance
 *   built in a test would prove nothing about what this function produces.
 */
export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  const options: pino.LoggerOptions = {
    level,
    /*
     * Redaction is not optional. A credential in a log line is a credential in log
     * storage, replicated to wherever logs are shipped, and retained for as long as
     * the retention policy says — long after the key it names has been forgotten
     * about. Anything that could carry one is censored by shape rather than by
     * remembering to omit it at each call site.
     *
     * The presigned-upload fields are the least obvious of these: `fields.Policy`
     * and `fields['X-Amz-Signature']` together are a working upload credential for
     * the staging prefix, and they pass through the API as ordinary response data.
     */
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers.cookie',
        'headers.authorization',
        'headers["x-api-key"]',
        // Presigned POST targets, at any nesting depth.
        '*.fields',
        '*.upload.fields',
        'upload.fields',
        '*.signature',
        '*.Signature',
        '*.presignedUrl',
        '*.url',
        // API keys, wherever they surface.
        '*.plaintext',
        '*.apiKey',
        '*.hash',
        'apiKey.hash',
        // Database credentials, if a connection error ever carries the URL.
        '*.connectionString',
        '*.password',
      ],
      censor: '[redacted]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Merge the request context into every line emitted within a request.
    mixin() {
      const ctx = requestContext.getStore();
      return ctx === undefined ? {} : { correlationId: ctx.correlationId, assetId: ctx.assetId };
    },
  };

  return destination === undefined ? pino(options) : pino(options, destination);
}

/** Records the asset id on the active request context so later logs carry it. */
export function bindAssetId(assetId: string): void {
  const ctx = requestContext.getStore();
  if (ctx !== undefined) ctx.assetId = assetId;
}
