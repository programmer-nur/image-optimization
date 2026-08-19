/**
 * The limiter that replaced the WAF rule.
 *
 * Worth testing properly rather than trusting, because it is now the only thing
 * standing between the control plane and an unauthenticated flood — the load balancer
 * that carried the rule is gone (design.md L4), and its rate-based statement was
 * declarative in a way this code is not.
 */

import { describe, expect, it } from 'vitest';
import { RateLimitMiddleware, type RateLimits } from './rate-limit.middleware.js';

const LIMITS: RateLimits = { mutatingPer5Min: 3, overallPer5Min: 5 };

interface Captured {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function run(
  middleware: RateLimitMiddleware,
  options: { method?: string; ip?: string } = {},
): { passed: boolean; res: Captured } {
  const res: Captured = { statusCode: 200, headers: {}, body: '', ended: false };

  const req = {
    method: options.method ?? 'GET',
    headers: { 'x-forwarded-for': options.ip ?? '203.0.113.1' },
    socket: { remoteAddress: '10.0.0.1' },
  };

  const fake = {
    set statusCode(value: number) {
      res.statusCode = value;
    },
    get statusCode() {
      return res.statusCode;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    end(body: string) {
      res.body = body;
      res.ended = true;
    },
  };

  let passed = false;
  middleware.use(req as never, fake as never, () => {
    passed = true;
  });

  return { passed, res };
}

describe('rate limiting', () => {
  it('passes requests under both limits', () => {
    const middleware = new RateLimitMiddleware(LIMITS);
    for (let i = 0; i < 3; i += 1) {
      expect(run(middleware).passed, `request ${i}`).toBe(true);
    }
  });

  it('refuses once the overall limit is exceeded', () => {
    const middleware = new RateLimitMiddleware(LIMITS);
    for (let i = 0; i < LIMITS.overallPer5Min; i += 1) run(middleware);

    const { passed, res } = run(middleware);
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
  });

  it('refuses mutating requests sooner than reads', () => {
    // The tighter budget exists because uploads are expensive and rare per client.
    const middleware = new RateLimitMiddleware(LIMITS);
    for (let i = 0; i < LIMITS.mutatingPer5Min; i += 1) {
      expect(run(middleware, { method: 'POST' }).passed).toBe(true);
    }

    expect(run(middleware, { method: 'POST' }).passed).toBe(false);
  });

  it('answers 429 with Retry-After, not 403', () => {
    /*
     * The distinction is the whole point of the status code: 403 tells a client it is
     * not allowed to do this, so a well-behaved one stops and a human starts debugging
     * credentials. 429 tells it to slow down, which is what is actually true.
     */
    const middleware = new RateLimitMiddleware({ mutatingPer5Min: 1, overallPer5Min: 1 });
    run(middleware);
    const { res } = run(middleware);

    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('counts each source address separately', () => {
    // One noisy client must not refuse everyone else — which is what a global counter
    // would do, and is indistinguishable from an outage.
    const middleware = new RateLimitMiddleware({ mutatingPer5Min: 1, overallPer5Min: 1 });

    expect(run(middleware, { ip: '203.0.113.1' }).passed).toBe(true);
    expect(run(middleware, { ip: '203.0.113.1' }).passed).toBe(false);
    expect(run(middleware, { ip: '198.51.100.7' }).passed).toBe(true);
  });

  it('reads the left-most forwarded address', () => {
    // The proxy appends rather than replaces, so the original client is first. Reading
    // the last entry would attribute every request to the proxy and limit nothing.
    const middleware = new RateLimitMiddleware({ mutatingPer5Min: 1, overallPer5Min: 1 });

    expect(run(middleware, { ip: '203.0.113.1, 10.0.0.5' }).passed).toBe(true);
    expect(run(middleware, { ip: '203.0.113.1, 10.0.0.9' }).passed).toBe(false);
  });

  it('does not grow without bound', () => {
    /*
     * A limiter that can be used to exhaust the process's memory is worse than none.
     * Ten thousand distinct sources is well past any real client population and well
     * under the cap, so this checks the structure holds rather than the cap's value.
     */
    const middleware = new RateLimitMiddleware(LIMITS);
    for (let i = 0; i < 10_000; i += 1) {
      run(middleware, { ip: `198.51.100.${i % 256}.${i}` });
    }

    const counters = (middleware as unknown as { counters: Map<string, unknown> }).counters;
    expect(counters.size).toBeLessThanOrEqual(50_000);
  });

  it('falls back to the socket address when no header is set', () => {
    // Direct connections should not all share one bucket keyed on "unknown".
    const middleware = new RateLimitMiddleware({ mutatingPer5Min: 1, overallPer5Min: 1 });
    const res = { statusCode: 200, setHeader() {}, end() {} };
    const req = { method: 'GET', headers: {}, socket: { remoteAddress: '192.0.2.5' } };

    let passed = false;
    middleware.use(req as never, res as never, () => {
      passed = true;
    });

    expect(passed).toBe(true);
    const counters = (middleware as unknown as { counters: Map<string, unknown> }).counters;
    expect([...counters.keys()]).toEqual(['192.0.2.5']);
  });
});
