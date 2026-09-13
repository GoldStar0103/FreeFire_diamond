import type { Metadata } from 'next';
import Link from 'next/link';
import { listStorefront } from '@levelup/db';
import { getDb } from '../../lib/server';
import { diamonds, mxn } from '../../lib/format';
import { flyerUrl } from '../../lib/assets';

export const metadata: Metadata = {
  title: 'Promociones',
  description: 'Todas las promociones del mes, con todos sus paquetes.',
  alternates: { canonical: '/promociones' },
};

export const dynamic = 'force-dynamic';

/**
 * Every campaign, full flyer and full combo grid, one after another.
 *
 * The homepage is deliberately a teaser — one flyer per campaign, one tap to
 * see more (see /promocion/[key]). This page is the "see everything" version
 * for someone who came here specifically to browse promotions, which is what
 * the client's own mockup shows as its own bottom-nav destination rather than
 * a duplicate of the homepage.
 */
export default async function PromocionesPage() {
  const campaigns = await listStorefront(getDb());

  return (
    <main className="page">
      <h1 className="page-title">Promociones del mes</h1>
      <p className="page-sub">Todo lo que tenemos activo ahora mismo, en un solo lugar.</p>

      {campaigns.length === 0 && (
        <div className="card empty">Estamos preparando las promociones del mes. Vuelve pronto.</div>
      )}

      {campaigns.map((campaign) => {
        const flyer = flyerUrl(campaign.flyerAssetUrl);

        return (
          <section key={campaign.key} className="promo-section">
            <Link href={`/promocion/${campaign.key}`}>
              {flyer ? (
                <img className="flyer" src={flyer} alt={campaign.name} loading="lazy" decoding="async" />
              ) : (
                <div className="flyer promo-flyer-empty">{campaign.name}</div>
              )}
            </Link>

            <div className="promo-section-head">
              <h2 className="promo-section-title">{campaign.name}</h2>
              {campaign.badge && <span className="mega-tag">{campaign.badge}</span>}
            </div>

            <div className="combo-grid">
              {campaign.combos.map((combo) => (
                <Link key={combo.key} href={`/comprar/${combo.key}`} className="card combo">
                  <div className="combo-diamonds">{diamonds(combo.advertisedDiamonds)} 💎</div>
                  <div className="combo-name">{combo.name}</div>
                  <div className="combo-price">{mxn(combo.priceMxnCents)}</div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </main>
  );
}
