/**
 * In-memory sliding-window rate limiter.
 *
 * Built for the player-ID validation endpoint. That call costs LevelUp nothing
 * directly, but it hits the provider on every lookup, and this audience —
 * teenagers poking at a Free Fire site — will hammer it. Left open it is both
 * a way to annoy the provider and a free ID-enumeration oracle.
 *
 * Single-process by design: the storefront runs as one Node process on one VPS,
 * so a shared store would be machinery without a purpose. If the app is ever
 * scaled horizontally this needs to move to Postgres or Redis, because per-
 * instance counters would silently multiply the effective limit.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests left in the current window. */
  remaining: number;
  /** How long until the next request would be allowed. Zero when allowed. */
  retryAfterMs: number;
}

export interface RateLimiterOptions {
  /** Requests permitted per window. */
  limit: number;
  windowMs: number;
  /** Injectable for tests. */
  now?: () => number;
  /**
   * Stop tracking keys after this long idle. Without it the map grows for every
   * IP that ever visits, which is a slow memory leak on a long-lived process.
   */
  evictAfterMs?: number;
}

export interface RateLimiter {
  check(key: string): RateLimitDecision;
  /** Observability for the admin panel and for tests. */
  size(): number;
  reset(key?: string): void;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  if (limit < 1) throw new RangeError('limit must be at least 1');
  if (windowMs < 1) throw new RangeError('windowMs must be positive');

  const now = options.now ?? (() => Date.now());
  const evictAfterMs = options.evictAfterMs ?? windowMs * 10;

  /** key -> timestamps of requests still inside the window. */
  const hits = new Map<string, number[]>();
  let lastSweep = now();

  function sweep(current: number): void {
    // Amortised: only walk the whole map once per window, not per request.
    if (current - lastSweep < windowMs) return;
    lastSweep = current;
    for (const [key, timestamps] of hits) {
      const newest = timestamps[timestamps.length - 1];
      if (newest === undefined || current - newest > evictAfterMs) hits.delete(key);
    }
  }

  return {
    check(key: string): RateLimitDecision {
      const current = now();
      sweep(current);

      const cutoff = current - windowMs;
      const timestamps = (hits.get(key) ?? []).filter((t) => t > cutoff);

      if (timestamps.length >= limit) {
        // The oldest hit in the window is what has to age out.
        const oldest = timestamps[0]!;
        hits.set(key, timestamps);
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.max(1, oldest + windowMs - current),
        };
      }

      timestamps.push(current);
      hits.set(key, timestamps);

      return { allowed: true, remaining: limit - timestamps.length, retryAfterMs: 0 };
    },

    size: () => hits.size,

    reset(key?: string) {
      if (key === undefined) hits.clear();
      else hits.delete(key);
    },
  };
}
