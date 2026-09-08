import Link from 'next/link';
import { countCompletedOrders, listStorefront } from '@levelup/db';
import { db } from '../lib/server';
import { diamonds, mxn } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [campaigns, delivered] = await Promise.all([
    listStorefront(db),
    countCompletedOrders(db),
  ]);

  // Permanent campaigns sort first, so the $10 entry offer leads. It is the
  // trust-breaker for first-time buyers, not just another promo.
  const [hero, ...rest] = campaigns;

  return (
    <main className="page">
      <header className="hero">
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

      {(hero?.permanent ? rest : campaigns).map((campaign) => (
        <section key={campaign.key} className="campaign">
          <h2>{campaign.name}</h2>

          {campaign.flyerAssetUrl && (
            // The flyer is the brand — it is also what they post on social, so
            // it stays. The purchasable combos are real cards beneath it, never
            // text baked into the image.
            <img className="flyer" src={campaign.flyerAssetUrl} alt={campaign.name} />
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
      ))}

      {campaigns.length === 0 && (
        <div className="card empty">Estamos preparando las promociones del mes. Vuelve pronto.</div>
      )}
    </main>
  );
}
