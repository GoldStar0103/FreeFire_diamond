import type { MetadataRoute } from 'next';
import { listStorefront } from '@levelup/db';
import { db } from '../lib/server';
import { siteUrl } from '../lib/site';

/**
 * Built from what is actually on sale, not a hand-kept list.
 *
 * The catalog rotates monthly and the client manages it themselves, so a
 * static sitemap would be wrong within weeks — advertising combos that have
 * been retired and omitting the ones being promoted. Reading the same query
 * the homepage uses means it cannot drift.
 *
 * Order pages are deliberately absent; see robots.ts.
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticPages: MetadataRoute.Sitemap = [
    { url: siteUrl('/'), lastModified: now, changeFrequency: 'daily', priority: 1 },
    { url: siteUrl('/confianza'), lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
    { url: siteUrl('/pedidos'), lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
    { url: siteUrl('/legal/terminos'), lastModified: now, changeFrequency: 'yearly', priority: 0.2 },
    {
      url: siteUrl('/legal/privacidad'),
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.2,
    },
  ];

  let campaigns: Awaited<ReturnType<typeof listStorefront>> = [];
  try {
    campaigns = await listStorefront(db);
  } catch (err) {
    // A sitemap is a nicety. Failing it should not turn into a 500 that a
    // crawler reads as the whole site being broken.
    console.error('[sitemap] could not list the storefront', err);
  }

  const combos: MetadataRoute.Sitemap = campaigns.flatMap((campaign) =>
    campaign.combos.map((combo) => ({
      url: siteUrl(`/comprar/${combo.key}`),
      lastModified: now,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
  );

  return [...staticPages, ...combos];
}
