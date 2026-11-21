import type { Metadata } from 'next';
import Link from 'next/link';
import { getArsRate, getItemMarkupPercent, listStorefrontItems } from '@levelup/db';
import { getDb } from '../../lib/server';
import { mxn } from '../../lib/format';
import { SiteHeader } from '../site-header';

export const metadata: Metadata = {
  title: 'Artículos',
  description: 'Cajas, fragmentos y membresías de RocketPass, con stock limitado.',
  alternates: { canonical: '/articulos' },
};

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<'gift' | 'membership', string> = { gift: 'Artículo', membership: 'Membresía' };

function stockLabel(stockByRegion: Record<string, number>): string | null {
  const total = Object.values(stockByRegion).reduce((sum, n) => sum + n, 0);
  if (Object.keys(stockByRegion).length === 0) return null;
  if (total === 0) return 'Sin stock';
  return `${total} disponibles`;
}

export default async function ArticulosPage() {
  const db = getDb();
  const [arsRate, markupPercent] = await Promise.all([getArsRate(db), getItemMarkupPercent(db)]);
  const items = await listStorefrontItems(db, { arsRate, markupPercent });

  return (
    <main className="page pr">
      <SiteHeader />

      <section className="pr-head" aria-labelledby="art-titulo">
        <span className="pr-eyebrow">
          <i aria-hidden="true" />
          Artículos
        </span>
        <h1 id="art-titulo">
          Cajas, fragmentos <em>y membresías</em>
        </h1>
        <p>Stock limitado, vendido tal cual lo reporta el proveedor — vuelve seguido.</p>
      </section>

      {items.length === 0 ? (
        <div className="card empty">Estamos preparando el catálogo de artículos. Vuelve pronto.</div>
      ) : (
        <div className="art-grid">
          {items.map((item) => {
            const sold = Object.keys(item.stockByRegion).length > 0 &&
              Object.values(item.stockByRegion).every((n) => n === 0);
            const card = (
              <>
                <span className="art-card-kind">{KIND_LABEL[item.kind]}</span>
                <span className="art-card-name">{item.displayName}</span>
                <span className="art-card-price">{mxn(item.salePriceMxnCents)}</span>
                {stockLabel(item.stockByRegion) && (
                  <span className={`art-card-stock${sold ? ' is-sold-out' : ''}`}>
                    {stockLabel(item.stockByRegion)}
                  </span>
                )}
                <span className="art-card-cta">{sold ? 'Agotado' : 'Comprar →'}</span>
              </>
            );

            // A sold-out card has nowhere to navigate to, so it renders as a
            // plain non-interactive div rather than a Link whose navigation
            // needs blocking — a Server Component can't pass an onClick
            // handler to Link, since a function isn't serializable across
            // the server/client boundary (confirmed in production: crashed
            // the whole page with "Event handlers cannot be passed to
            // Client Component props").
            return sold ? (
              <div key={item.sku} className="card art-card is-sold-out" aria-disabled="true">
                {card}
              </div>
            ) : (
              <Link key={item.sku} href={`/comprar-articulo/${item.sku}`} className="card art-card">
                {card}
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
