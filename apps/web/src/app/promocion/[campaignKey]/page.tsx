import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getStorefrontCampaign } from '@levelup/db';
import { getDb } from '../../../lib/server';
import { diamonds, mxn } from '../../../lib/format';
import { flyerUrl } from '../../../lib/assets';

export const dynamic = 'force-dynamic';

/**
 * One campaign's own page: its flyer, full-size, and every combo in it.
 *
 * Split out of the homepage so the homepage itself can stay a lightweight
 * carousel of flyers — this is where the detail the homepage used to show
 * inline now lives, one tap away.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ campaignKey: string }>;
}): Promise<Metadata> {
  const { campaignKey } = await params;
  const campaign = await getStorefrontCampaign(getDb(), campaignKey);

  if (!campaign) return { title: 'Promoción no disponible' };

  return {
    title: `${campaign.name} — LevelUp Store`,
    alternates: { canonical: `/promocion/${campaign.key}` },
  };
}

export default async function PromotionPage({
  params,
}: {
  params: Promise<{ campaignKey: string }>;
}) {
  const { campaignKey } = await params;
  const campaign = await getStorefrontCampaign(getDb(), campaignKey);

  if (!campaign) notFound();

  const flyer = flyerUrl(campaign.flyerAssetUrl);

  return (
    <main className="page">
      <Link href="/" className="back">
        ← Volver
      </Link>

      {flyer && (
        <img
          className="flyer"
          src={flyer}
          alt={campaign.name}
          decoding="async"
        />
      )}

      <h1 className="page-title">{campaign.name}</h1>

      <div className="combo-grid">
        {campaign.combos.map((combo) => (
          <Link key={combo.key} href={`/comprar/${combo.key}`} className="card combo">
            <div className="combo-diamonds">{diamonds(combo.advertisedDiamonds)} 💎</div>
            <div className="combo-name">{combo.name}</div>
            <div className="combo-price">{mxn(combo.priceMxnCents)}</div>
          </Link>
        ))}
      </div>
    </main>
  );
}
