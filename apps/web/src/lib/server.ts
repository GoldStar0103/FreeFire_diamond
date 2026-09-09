/**
 * Shared server singletons for the storefront.
 *
 * All cached on `globalThis` because Next reloads modules on every edit in dev;
 * without it each hot reload opens a new connection pool and creates a fresh
 * rate-limit map, which quietly makes the limiter useless while developing.
 */

import 'server-only';
import { headers } from 'next/headers';
import { createDb } from '@levelup/db';
import { createRateLimiter, type RateLimiter } from '@levelup/shared';
import { RecargasAmericaProvider, ProviderSimulator, type TopupProvider } from '@levelup/provider';

declare global {
  // eslint-disable-next-line no-var
  var __webDb: ReturnType<typeof createDb> | undefined;
  // eslint-disable-next-line no-var
  var __webValidationLimiter: RateLimiter | undefined;
  // eslint-disable-next-line no-var
  var __webLookupLimiter: RateLimiter | undefined;
  // eslint-disable-next-line no-var
  var __webProvider: TopupProvider | undefined;
}

function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return createDb(url, { max: 10 });
}

/**
 * Opened on first use, not at import.
 *
 * `next build` evaluates every route's modules to collect page data, so an
 * eager connect made DATABASE_URL a *build-time* requirement — and the build
 * is exactly where it is not available. The container image builds with no
 * environment at all, so `docker build` would have failed on this, and so
 * would CI. Building should not need infrastructure.
 *
 * postgres.js does not open a socket until the first query regardless; the
 * eager part was only the check, which is now where it belongs — at the point
 * something actually wants the database.
 */
let handle: ReturnType<typeof createDb> | undefined;

export function getDb(): ReturnType<typeof createDb>['db'] {
  // Two layers, and both are needed. The module-level `handle` is the real
  // singleton — without it every call would open another pool in production.
  // The `globalThis` copy survives the module reloads Next does on every edit
  // in development, which would otherwise leak a pool per save.
  handle ??= globalThis.__webDb ?? connect();
  if (process.env.NODE_ENV !== 'production') globalThis.__webDb = handle;
  return handle.db;
}

/**
 * The validation endpoint calls the provider on every lookup. It costs nothing
 * directly, but left open it annoys the provider and doubles as a free
 * ID-enumeration oracle.
 */
export const validationLimiter: RateLimiter =
  globalThis.__webValidationLimiter ??
  createRateLimiter({
    limit: Number(process.env.VALIDATE_RATE_LIMIT ?? 12),
    windowMs: Number(process.env.VALIDATE_RATE_WINDOW_MS ?? 60_000),
  });
if (process.env.NODE_ENV !== 'production') globalThis.__webValidationLimiter = validationLimiter;

/**
 * Order lookup is its own limiter, and tighter.
 *
 * The order-number-plus-player-ID pairing makes guessing impractical, but an
 * unlimited endpoint still lets someone grind order numbers against a player
 * ID they already know. A real customer looks up their order a handful of
 * times, so a low ceiling costs nothing.
 */
export const lookupLimiter: RateLimiter =
  globalThis.__webLookupLimiter ??
  createRateLimiter({
    limit: Number(process.env.LOOKUP_RATE_LIMIT ?? 10),
    windowMs: Number(process.env.LOOKUP_RATE_WINDOW_MS ?? 300_000),
  });
if (process.env.NODE_ENV !== 'production') globalThis.__webLookupLimiter = lookupLimiter;

function buildProvider(): TopupProvider {
  if (process.env.WEB_DRY_RUN === 'true') {
    return new ProviderSimulator({
      validatableProducts: ['351', '348', '350', '347', '346', '349'],
      knownPlayers: { '7288567050': 'ElCarneseca' },
    });
  }
  const apiKey = process.env.RA_API_KEY;
  if (!apiKey) throw new Error('RA_API_KEY is not set (or set WEB_DRY_RUN=true)');
  return new RecargasAmericaProvider({
    baseUrl: process.env.RA_BASE_URL ?? 'https://panel.recargasamerica.com/api/v1',
    apiKey,
    // Player validation sits in front of a form the customer is waiting on.
    timeoutMs: 12_000,
  });
}

/**
 * Built on first use, not at import.
 *
 * Only the buy flow talks to the provider, but every page that needs `db`
 * imports this module — so an eager build meant a missing or mistyped
 * RA_API_KEY took down the order-status page too. That is exactly backwards:
 * the customers who most need to see their order are the ones who have already
 * paid, and the provider being unreachable is precisely when they will look.
 *
 * Failing here still fails loudly, just scoped to the flow that needs it.
 */
export function getProvider(): TopupProvider {
  const existing = globalThis.__webProvider;
  if (existing) return existing;

  const built = buildProvider();
  if (process.env.NODE_ENV !== 'production') globalThis.__webProvider = built;
  return built;
}

/**
 * Caller IP for rate limiting.
 *
 * Behind Caddy, so the proxy headers are trustworthy here. Directly exposed
 * they would not be — a client can send whatever it likes.
 */
export async function callerIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return h.get('x-real-ip') ?? 'unknown';
}
