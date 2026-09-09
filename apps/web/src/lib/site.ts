/**
 * The site's own absolute URL.
 *
 * Needed because Open Graph and canonical tags must be absolute — a relative
 * `og:image` is ignored by every scraper, which is the quiet way a link ends up
 * previewing as a grey box. `PUBLIC_DOMAIN` is configured as a bare hostname
 * for the legal pages, so the scheme is added here rather than asking whoever
 * edits the env file to remember which format each consumer wants.
 */

const FALLBACK = 'levelupstore.mx';

/**
 * Accepts `levelupstore.mx`, `https://levelupstore.mx`, or either with a
 * trailing slash, and always returns an origin with no trailing slash.
 *
 * http is preserved only for localhost, so a developer can point at
 * `localhost:3000` and have previews resolve; anything else is forced to https
 * because that is what the site serves and a mixed-scheme og:image is dropped.
 */
export function siteOrigin(domain: string | undefined = process.env.PUBLIC_DOMAIN): string {
  const raw = domain?.trim().replace(/\/+$/, '') || FALLBACK;

  // A bare hostname gets https, except a local one — `localhost:3000` in a dev
  // .env is the natural thing to write, and defaulting it to https produced a
  // sitemap and canonical tags pointing at a URL the dev server does not serve.
  const bareIsLocal = /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(raw);
  const withScheme = /^https?:\/\//i.test(raw)
    ? raw
    : `${bareIsLocal ? 'http' : 'https'}://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return `https://${FALLBACK}`;
  }

  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';

  // A public domain has a dot in it. Without this check a malformed value can
  // parse into something that looks like a URL but is not a site — `http://`
  // becomes the host `http` — and the result would be quietly wrong on every
  // preview card rather than obviously wrong once.
  if (!isLocal && !parsed.hostname.includes('.')) return `https://${FALLBACK}`;

  if (!isLocal) parsed.protocol = 'https:';

  return parsed.origin;
}

/** An absolute URL for a path on this site. */
export const siteUrl = (path = '/'): string => new URL(path, siteOrigin()).toString();
