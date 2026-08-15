/**
 * Request completion logging and metrics.
 *
 * One record per request carrying route, status, duration, correlation id, and the
 * asset id when the handler bound one — which is what makes "filter by asset id" the
 * single operation that reconstructs an upload's whole lifecycle across the API, the
 * queue, and the optimizer.
 *
 * Registered on the Fastify instance rather than as a Nest interceptor so it also
 * covers requests Nest never routes: a 404 for an unknown path, a payload rejected
 * by the body limit, a malformed multipart body. Those are exactly the requests
 * worth seeing during an incident, and an interceptor sees none of them.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { recordRequest } from '@imgopt/metrics';
import { requestContext } from './logger.js';

/** Nothing here is worth a log line or a metric datapoint. */
const IGNORED_ROUTES = new Set(['/healthz', '/readyz']);

/**
 * The route *pattern*, never the resolved path.
 *
 * `/v1/images/:id` is one metric series; the resolved form would be one series per
 * asset ever requested, which is both an unusable graph and an unbounded bill.
 * Fastify exposes the matched pattern on `routeOptions`; the fallback only applies
 * to requests that matched no route at all.
 */
function routePattern(request: FastifyRequest): string {
  return request.routeOptions?.url ?? 'unmatched';
}

export function registerRequestLogging(app: FastifyInstance, logger: Logger): void {
  app.addHook('onResponse', (request, reply, done) => {
    const route = routePattern(request);
    if (IGNORED_ROUTES.has(route)) {
      done();
      return;
    }

    const durationMs = reply.elapsedTime;
    const context = requestContext.getStore();

    logger.info(
      {
        route,
        method: request.method,
        status: reply.statusCode,
        durationMs: Math.round(durationMs),
        ...(context?.assetId !== undefined ? { assetId: context.assetId } : {}),
      },
      'request completed',
    );

    recordRequest({ route, status: reply.statusCode, durationMs });
    done();
  });
}
