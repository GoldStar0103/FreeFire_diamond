/**
 * Which header actually names the caller, given what reaches this app.
 *
 * Deliberately its own module, with no `'server-only'`/`next/headers`
 * dependency: those can only be exercised inside a real Next request, so the
 * one part of `callerIp()` (`lib/server.ts`) worth getting exactly right — the
 * trust decision a rate limiter's whole point rests on — lives here where it
 * can be tested directly.
 *
 * `X-Real-IP` first, not `X-Forwarded-For`. `docker/Caddyfile` overwrites
 * both with `header_up ... {remote_host}` — a client-supplied value never
 * survives either header — but that used to be true only for `X-Real-IP`.
 * `X-Forwarded-For` reading first meant a client sending a fresh random value
 * on every request got a fresh rate-limit bucket every time; `validationLimiter`
 * and `lookupLimiter` were bypassable just by setting the header.
 */
export interface HeaderLike {
  get(name: string): string | null;
}

export function pickCallerIp(h: HeaderLike): string {
  const real = h.get('x-real-ip');
  if (real?.trim()) return real.trim();
  // Fallback for local dev without Caddy in front — not authoritative in
  // production, where X-Real-IP is always set.
  const forwarded = h.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || 'unknown';
}
