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

/** Matches RocketPass's own reseller dashboard naming (confirmed against a real screenshot: "SUR"/"US"), not `RocketPassRegion`'s internal 'SAC' code. */
const REGION_SHORT_LABEL: Record<string, string> = { SAC: 'SUR', US: 'US' };
const REGION_ORDER = ['SAC', 'US'];

/**
 * Per region, not combined — Jose's own report 2026-11-27: a single summed
 * total (e.g. "505 disponibles") hides that it might all be in one region,
 * same gap he pointed at in RocketPass's own dashboard showing "SUR: 505
 * US: 0" instead. A region with zero stock is shown too, not hidden, same
 * as that reference.
 */
function stockLabel(stockByRegion: Record<string, number>): string | null {
  const regions = Object.keys(stockByRegion);
  if (regions.length === 0) return null;
  const ordered = [...regions].sort((a, b) => REGION_ORDER.indexOf(a) - REGION_ORDER.indexOf(b));
  return ordered.map((r) => `${REGION_SHORT_LABEL[r] ?? r}: ${stockByRegion[r]}`).join(' · ');
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
