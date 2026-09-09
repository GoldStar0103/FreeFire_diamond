/**
 * Turning a stored asset key into something a browser can fetch.
 *
 * The admin panel saves a storage KEY on the campaign — `flyers/<promo>/<uuid>.jpg`
 * — not a URL. That is the right call: it keeps the storage backend swappable.
 * But a key is not an `src`. Rendered directly it becomes a relative path, so
 * the browser resolves it against whatever page it happens to be on and asks
 * for a file the server does not expose, and the flyer silently breaks.
 *
 * Everything the storefront displays goes through here, so there is one place
 * that knows how a key becomes a URL.
 */

/** Only flyers are public. Comprobantes live under their own prefix. */
export const FLYER_PREFIX = 'flyers/';

/** Where the storefront serves public assets from. */
export const MEDIA_ROUTE = '/media/';

/**
 * Resolve a stored flyer value to a URL, or null if it cannot be shown.
 *
 * Absolute `https://` values pass through untouched, which is what makes a move
 * to R2 or a CDN a data migration rather than a code change — the tests already
 * cover campaigns holding a CDN URL.
 *
 * Anything else is treated as a storage key and must sit under `flyers/`. A key
 * pointing anywhere else returns null rather than a URL: this function is the
 * only thing standing between an operator-editable database column and a public
 * fetch, and a bank receipt reachable because someone pasted the wrong key into
 * the wrong field is not a mistake worth leaving room for.
 */
export function flyerUrl(stored: string | null | undefined): string | null {
  const value = stored?.trim();
  if (!value) return null;

  // Only http(s) is a real image source. `javascript:` and `data:` in an <img>
  // src are less dangerous than in an href, but neither belongs here, and
  // protocol-relative `//host/x` silently inherits our scheme and host trust.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith('//')) {
    return /^https?:\/\//i.test(value) ? value : null;
  }

  if (value.startsWith('/')) return null;
  if (!value.startsWith(FLYER_PREFIX)) return null;
  if (value.includes('..')) return null;

  const segments = value.split('/').filter(Boolean);
  if (segments.length < 2) return null;

  return MEDIA_ROUTE + segments.map(encodeURIComponent).join('/');
}
