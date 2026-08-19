/**
 * Rate limiting, in the application.
 *
 * This used to be a WAF rule on the load balancer, and moving it here is a genuine
 * downgrade that is worth naming rather than glossing: a request now costs a
 * connection, a parse, and a little work before it is refused, where WAF refused it
 * before an origin was touched at all. It is here because a WAF cannot attach to a
 * Lightsail instance — the `REGIONAL` scope covers ALB, API Gateway, and AppSync —
 * and keeping one would mean keeping the load balancer this change exists to remove
 * (design.md L4).
 *
 * The old comment on the WAF module argued that a per-instance limiter "is not a
 * limiter", because the control plane autoscaled and an attacker's budget was the
 * limit times the task count. That objection is exactly void at one instance, and it
 * comes straight back the moment there is a second one — so it is recorded as a
 * precondition of the ECS migration in L7 rather than left as a comment that quietly
 * became wrong.
 *
 * In-memory, and correct only because there is one process. It holds counters for
 * active source addresses and nothing else; there is no persistence, and a restart
 * forgives everyone, which is the right failure direction for a limiter that is not
 * the only control in front of the service.
 */

import { Inject, Injectable, Optional, type NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Requests per five-minute window, per source address. Mirrors the WAF it replaces. */
export interface RateLimits {
  /** Mutating verbs — uploads are expensive and rare per client. */
  mutatingPer5Min: number;
  /** A looser ceiling covering everything, to blunt broad scraping. */
  overallPer5Min: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  mutatingPer5Min: 300,
  overallPer5Min: 3000,
};

/**
 * Optional override token.
 *
 * `RateLimits` is an interface and erases at runtime, so Nest has nothing to resolve a
 * bare constructor parameter against — it fails at startup with "can't resolve
 * dependencies", which is what happened the first time this shipped. `@Optional()` on
 * a symbol token lets the class construct with no provider registered and still be
 * constructed directly with explicit limits in a test.
 */
export const RATE_LIMITS = Symbol('RATE_LIMITS');

const WINDOW_MS = 5 * 60 * 1000;

/** Verbs that count against the tighter budget. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface Counter {
  overall: number;
  mutating: number;
  /** Start of the current window. Windows are fixed, not sliding. */
  windowStart: number;
}

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly counters = new Map<string, Counter>();
  private readonly limits: RateLimits;

  /**
   * Bounds the table.
   *
   * Without a cap, a source spoofing addresses turns the limiter itself into the
   * memory exhaustion it was meant to prevent — a limiter that can be used to kill
   * the process is worse than none. On overflow the oldest windows are dropped, which
   * forgives some clients rather than refusing all of them.
   */
  private readonly maxTracked = 50_000;

  constructor(@Optional() @Inject(RATE_LIMITS) limits?: RateLimits) {
    this.limits = limits ?? DEFAULT_RATE_LIMITS;
  }

  use(req: FastifyRequest['raw'], res: FastifyReply['raw'], next: () => void): void {
    const key = sourceOf(req);
    const now = Date.now();

    let counter = this.counters.get(key);
    if (counter === undefined || now - counter.windowStart >= WINDOW_MS) {
      counter = { overall: 0, mutating: 0, windowStart: now };
      this.counters.set(key, counter);
      if (this.counters.size > this.maxTracked) this.evict(now);
    }

    counter.overall += 1;
    const mutating = MUTATING.has(req.method ?? 'GET');
    if (mutating) counter.mutating += 1;

    const over =
      counter.overall > this.limits.overallPer5Min ||
      (mutating && counter.mutating > this.limits.mutatingPer5Min);

    if (over) {
      /*
       * 429, not 403.
       *
       * The distinction is the whole point of the status code: 403 tells a client it
       * is not allowed to do this, so a well-behaved one stops and a human starts
       * debugging credentials. 429 tells it to slow down, which is what is actually
       * true. `Retry-After` names the window rather than leaving the client to guess.
       */
      const retryAfter = Math.ceil((counter.windowStart + WINDOW_MS - now) / 1000);
      res.statusCode = 429;
      res.setHeader('retry-after', String(Math.max(retryAfter, 1)));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: { code: 'rate_limited', message: 'Too many requests. Retry after the window.' },
        }),
      );
      return;
    }

    next();
  }

  /** Drops windows that have already expired, then the oldest if that was not enough. */
  private evict(now: number): void {
    for (const [key, counter] of this.counters) {
      if (now - counter.windowStart >= WINDOW_MS) this.counters.delete(key);
    }
    if (this.counters.size <= this.maxTracked) return;

    const byAge = [...this.counters.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
    for (const [key] of byAge.slice(0, this.counters.size - this.maxTracked)) {
      this.counters.delete(key);
    }
  }
}

/**
 * The client address, taken from the proxy header the reverse proxy sets.
 *
 * `x-forwarded-for` is trusted here **because nothing but the local reverse proxy can
 * reach this port** — the container publishes only to the host, and the host firewall
 * exposes 80 and 443. Exposing the application port directly would make this header
 * client-controlled and the limiter trivially bypassable, which is a reason not to do
 * that rather than a reason to distrust the header.
 *
 * The left-most entry is the original client; the proxy appends rather than replaces.
 */
function sourceOf(req: FastifyRequest['raw']): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(',')[0]?.trim();
  return first !== undefined && first !== '' ? first : (req.socket.remoteAddress ?? 'unknown');
}
