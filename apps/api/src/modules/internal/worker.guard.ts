/**
 * Authentication for the internal worker routes.
 *
 * A shared secret, not an API key. The two are deliberately not interchangeable: an
 * API key belongs to a tenant and is scoped by it, while these routes act on whatever
 * asset a queue message named and must therefore be *unscoped*. Letting a customer key
 * through here would hand any tenant an unscoped write; letting this secret through on
 * the public API would hand a worker a tenant it has no business acting as.
 *
 * The secret is compared with `timingSafeEqual`. That matters more here than it looks:
 * unlike an API key, there is exactly one of these per deployment, it does not rotate
 * on its own, and it is presented on every optimize job — so a comparison that returns
 * early on the first differing byte is being fed a steady stream of samples.
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from '../../common/errors.js';
import { WORKER_SECRET } from '../../tokens.js';

/** The header workers present. Distinct from `x-api-key` so neither can be sent by accident. */
export const WORKER_SECRET_HEADER = 'x-imgopt-worker-secret';

export interface WorkerRequest {
  headers: Record<string, string | string[] | undefined>;
}

@Injectable()
export class WorkerGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(@Inject(WORKER_SECRET) secret: string) {
    this.expected = Buffer.from(secret, 'utf8');
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<WorkerRequest>();
    const presented = req.headers[WORKER_SECRET_HEADER];

    if (typeof presented !== 'string' || presented.length === 0) {
      throw ApiError.unauthorized('Worker authentication required.');
    }

    const candidate = Buffer.from(presented, 'utf8');

    /*
     * Length is checked before the constant-time compare, because `timingSafeEqual`
     * throws on a length mismatch rather than returning false. Comparing lengths first
     * does leak the secret's length — which is not the secret, and is the standard
     * trade every implementation of this makes.
     */
    if (candidate.length !== this.expected.length) {
      throw ApiError.unauthorized('Invalid worker credentials.');
    }
    if (!timingSafeEqual(candidate, this.expected)) {
      throw ApiError.unauthorized('Invalid worker credentials.');
    }

    return true;
  }
}
