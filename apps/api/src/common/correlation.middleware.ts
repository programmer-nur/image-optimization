/**
 * Correlation-id middleware.
 *
 * Runs the rest of the request inside an AsyncLocalStorage store so every log line,
 * and the correlation id that later rides the SQS message into the optimizer, share
 * one identifier. An inbound `x-correlation-id` is honoured rather than replaced, so
 * a caller's own trace id threads through us.
 */

import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { requestContext } from './logger.js';

export const CORRELATION_HEADER = 'x-correlation-id';

interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}
interface MinimalResponse {
  header?(name: string, value: string): void;
  setHeader?(name: string, value: string): void;
}

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: MinimalRequest, res: MinimalResponse, next: () => void): void {
    const inbound = req.headers[CORRELATION_HEADER];
    const correlationId =
      typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID();

    // Fastify exposes `header`; keep `setHeader` as a fallback for other adapters.
    if (typeof res.header === 'function') res.header(CORRELATION_HEADER, correlationId);
    else if (typeof res.setHeader === 'function') res.setHeader(CORRELATION_HEADER, correlationId);

    requestContext.run({ correlationId }, next);
  }
}
