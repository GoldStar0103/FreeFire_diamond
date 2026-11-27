import type { Metadata } from 'next';
import Link from 'next/link';
import { listStorefrontItems } from '@levelup/db';
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

function isSoldOut(item: { stockByRegion: Record<string, number> }): boolean {
  return (
    Object.keys(item.stockByRegion).length > 0 &&
    Object.values(item.stockByRegion).every((n) => n === 0)
  );
}

export default async function ArticulosPage() {
  const items = (await listStorefrontItems(getDb())).filter((item) => !isSoldOut(item));

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
          {items.map((item) => (
            <Link key={item.sku} href={`/comprar-articulo/${item.sku}`} className="card art-card">
              <span className="art-card-kind">{KIND_LABEL[item.kind]}</span>
              <span className="art-card-name">{item.displayName}</span>
              <span className="art-card-price">{mxn(item.salePriceMxnCents)}</span>
              {stockLabel(item.stockByRegion) && (
                <span className="art-card-stock">{stockLabel(item.stockByRegion)}</span>
              )}
              <span className="art-card-cta">Comprar →</span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
