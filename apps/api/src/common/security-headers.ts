/**
 * Security response headers for the control plane.
 *
 * The delivery plane gets an equivalent set from a CloudFront response-headers
 * policy (see `infra/cdk/lib/cdn-stack.ts`), so both planes answer with the same
 * posture. They are configured separately because they are served by entirely
 * different infrastructure, not because the requirement differs.
 *
 * `nosniff` is the one that matters most here and it is not boilerplate. This API
 * returns JSON describing attacker-supplied content — filenames, alt text, tags —
 * and a browser that sniffs a JSON response as HTML turns a stored string into a
 * script execution. It also backs the guarantee that a polyglot upload, which is
 * simultaneously a valid image and a valid HTML document, can never be interpreted
 * as the latter.
 */

import type { FastifyInstance } from 'fastify';

export const SECURITY_HEADERS: Record<string, string> = {
  // Never infer a content type from the bytes; trust the declared one only.
  'x-content-type-options': 'nosniff',
  // This API has no UI, so nothing it returns should ever be framed.
  'x-frame-options': 'DENY',
  // Keep asset ids and query strings out of the Referer sent to third parties.
  'referrer-policy': 'strict-origin-when-cross-origin',
  // A JSON API needs no ambient authority at all; deny the lot.
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
  // Responses describe one caller's assets and are never shared.
  'cache-control': 'no-store',
};

/**
 * HSTS is applied only on HTTPS.
 *
 * Sending it over plain HTTP is ignored by browsers, and in local development it
 * would pin `localhost` to HTTPS in the developer's browser — a genuinely annoying
 * thing to undo, and one that looks like a broken dev environment rather than a
 * header.
 */
export const HSTS = 'max-age=31536000; includeSubDomains';

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', (request, reply, payload, done) => {
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      // `onSend` runs after handlers, so a route that deliberately set its own
      // cache-control keeps it.
      if (reply.getHeader(header) === undefined) reply.header(header, value);
    }

    const proto = request.headers['x-forwarded-proto'] ?? request.protocol;
    if (proto === 'https' && reply.getHeader('strict-transport-security') === undefined) {
      reply.header('strict-transport-security', HSTS);
    }

    done(null, payload);
  });
}
