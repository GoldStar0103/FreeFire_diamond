import type { MetadataRoute } from 'next';
import { siteUrl } from '../lib/site';

/**
 * Order pages are the only thing here that must never be indexed. The URL
 * carries a Free Fire player ID, and the page shows what they bought and what
 * they paid — indexed, that becomes a searchable record of someone's purchases
 * tied to their game account.
 *
 * The route already sends `X-Robots-Tag: noindex` (see next.config.mjs), which
 * is the header that actually binds. This is the belt to that pair of braces,
 * and it stops well-behaved crawlers requesting the pages at all rather than
 * fetching and then discarding them.
 */
/**
 * Per request, because the sitemap URL is built from PUBLIC_DOMAIN. Prerendered,
 * it would bake in whatever the domain was at BUILD time — and an image built
 * without that variable would advertise a sitemap on the fallback domain
 * forever, which no restart would fix. Same trap as the legal pages.
 */
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/pedido/', '/api/'],
    },
    sitemap: siteUrl('/sitemap.xml'),
  };
}
