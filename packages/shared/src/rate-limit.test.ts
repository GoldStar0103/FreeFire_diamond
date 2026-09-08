import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit.js';

/** Controllable clock — real timers would make these slow and flaky. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('createRateLimiter', () => {
  it('allows requests up to the limit', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: clock().now });

    expect(limiter.check('ip').remaining).toBe(2);
    expect(limiter.check('ip').remaining).toBe(1);
    expect(limiter.check('ip')).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('blocks the request past the limit', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: clock().now });
    limiter.check('ip');
    limiter.check('ip');

    const blocked = limiter.check('ip');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('tracks keys independently', () => {
    // One noisy visitor must not lock out everyone else.
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock().now });

    expect(limiter.check('ip-a').allowed).toBe(true);
    expect(limiter.check('ip-a').allowed).toBe(false);
    expect(limiter.check('ip-b').allowed).toBe(true);
  });

  it('slides rather than resetting on a fixed boundary', () => {
    // A fixed window lets someone burst 2x the limit across the boundary.
    const c = clock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: c.now });

    limiter.check('ip');
    c.advance(900);
    limiter.check('ip');
    c.advance(50);

    expect(limiter.check('ip').allowed).toBe(false);

    // Only the first hit has aged out at this point.
    c.advance(60);
    expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(false);
  });

  it('recovers fully once the window passes', () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: c.now });
    limiter.check('ip');
    limiter.check('ip');
    expect(limiter.check('ip').allowed).toBe(false);

    c.advance(1001);
    expect(limiter.check('ip')).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('reports a retry delay that actually works', () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 5000, now: c.now });
    limiter.check('ip');

    const blocked = limiter.check('ip');
    expect(blocked.allowed).toBe(false);

    // Waiting exactly as long as advertised must be enough.
    c.advance(blocked.retryAfterMs);
    expect(limiter.check('ip').allowed).toBe(true);
  });

  it('evicts idle keys so the map does not grow forever', () => {
    // Every visiting IP would otherwise be retained for the process lifetime.
    const c = clock();
    const limiter = createRateLimiter({
      limit: 5,
      windowMs: 1000,
      evictAfterMs: 2000,
      now: c.now,
    });

    for (let i = 0; i < 50; i++) limiter.check(`ip-${i}`);
    expect(limiter.size()).toBe(50);

    c.advance(5000);
    limiter.check('someone-new');

    expect(limiter.size()).toBe(1);
  });

  it('keeps active keys through a sweep', () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000, evictAfterMs: 2000, now: c.now });

    limiter.check('busy');
    c.advance(1500);
    limiter.check('busy');
    c.advance(1500);
    limiter.check('busy');

    expect(limiter.size()).toBe(1);
  });

  it('can be reset for one key or all', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock().now });
    limiter.check('a');
    limiter.check('b');

    limiter.reset('a');
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(false);

    limiter.reset();
    expect(limiter.size()).toBe(0);
  });

  it.each([
    ['limit below one', { limit: 0, windowMs: 1000 }],
    ['non-positive window', { limit: 1, windowMs: 0 }],
  ])('rejects a nonsensical config (%s)', (_label, options) => {
    expect(() => createRateLimiter(options)).toThrow(RangeError);
  });
});
