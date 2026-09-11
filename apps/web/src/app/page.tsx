import type { Metadata } from 'next';
import Link from 'next/link';
import { countCompletedOrders, listStorefront } from '@levelup/db';
import { getDb } from '../lib/server';
import { diamonds, mxn } from '../lib/format';
import { flyerUrl } from '../lib/assets';
// Imported through the bundler rather than served from `public/`: the build
// emits it under /_next/static with a content hash, which the Docker image
// copies and browsers may cache forever. `public/` is not copied into the
// standalone image, so a logo there would boot fine locally and 404 in
// production.
import logo from '../assets/logo.webp';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { alternates: { canonical: '/' } };

export default async function HomePage() {
  const [campaigns, delivered] = await Promise.all([
    listStorefront(getDb()),
    countCompletedOrders(getDb()),
  ]);

  // Permanent campaigns sort first, so the $10 entry offer leads. It is the
  // trust-breaker for first-time buyers, not just another promo.
  const [hero, ...rest] = campaigns;

  return (
    <main className="page">
      <header className="hero">
        {/* The client's own brand, first thing on the page. This market has
            been scammed by stores that are a template and a price list; a
            real logo is part of what separates this one from those. Explicit
            dimensions so the heading does not jump when it arrives, and no
            lazy-loading — it is above the fold on every phone. */}
        <img
          className="hero-logo"
          src={logo.src}
          width={104}
          height={104}
          alt="LevelUp Store"
          decoding="async"
        />
        <h1>
          RECARGAS <span className="grad">AL INSTANTE</span>
        </h1>
        <p className="hero-sub">Diamantes de Free Fire directo a tu cuenta.</p>
        <div className="badges">
          <span>⚡ Entrega automática</span>
          <span>🛡️ Pago seguro</span>
          <span>💎 Sin contraseñas</span>
        </div>
      </header>

      {hero?.permanent && hero.combos[0] && (
        <Link href={`/comprar/${hero.combos[0].key}`} className="card mega">
          <div className="mega-tag">{hero.badge ?? 'Solo clientes nuevos'}</div>
          <div className="mega-name">{hero.name}</div>
          <div className="mega-diamonds">{diamonds(hero.combos[0].advertisedDiamonds)} 💎</div>
          <div className="mega-price">{mxn(hero.combos[0].priceMxnCents)}</div>
          <div className="mega-cta">Probar ahora →</div>
        </Link>
      )}

      {delivered > 0 && (
        <p className="trust-line">
          <strong>{delivered.toLocaleString('es-MX')}</strong> recargas entregadas
        </p>
      )}

      {(hero?.permanent ? rest : campaigns).map((campaign) => {
        // What the database holds is a storage key, not a URL. Rendering it
        // straight into `src` is what made every uploaded flyer a broken image.
        const flyer = flyerUrl(campaign.flyerAssetUrl);

        return (
          <section key={campaign.key} className="campaign">
            <h2>{campaign.name}</h2>

            {flyer && (
              // The flyer is the brand — it is also what they post on social, so
              // it stays. The purchasable combos are real cards beneath it, never
              // text baked into the image.
              <img
                className="flyer"
                src={flyer}
                alt={campaign.name}
                loading="lazy"
                decoding="async"
              />
            )}

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

      {campaigns.length === 0 && (
        <div className="card empty">Estamos preparando las promociones del mes. Vuelve pronto.</div>
      )}
    </main>
  );
}
