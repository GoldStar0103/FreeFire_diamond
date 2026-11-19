import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getArsRate, getItemMarkupPercent, getStorefrontItem } from '@levelup/db';
import { getDb } from '../../../lib/server';
import { mxn } from '../../../lib/format';
import { SiteHeader } from '../../site-header';
import { CheckoutArticulo } from './checkout-articulo';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ sku: string }>;
}): Promise<Metadata> {
  const { sku } = await params;
  const db = getDb();
  const item = await getStorefrontItem(db, sku, {
    arsRate: await getArsRate(db),
    markupPercent: await getItemMarkupPercent(db),
  });
  return {
    title: item?.displayName ?? 'Artículo',
    alternates: { canonical: `/comprar-articulo/${sku}` },
  };
}

export default async function ComprarArticuloPage({
  params,
  searchParams,
}: {
  params: Promise<{ sku: string }>;
  searchParams: Promise<{ cancelado?: string }>;
}) {
  const { sku } = await params;
  const { cancelado } = await searchParams;

  const db = getDb();
  const [arsRate, markupPercent] = await Promise.all([getArsRate(db), getItemMarkupPercent(db)]);
  const item = await getStorefrontItem(db, sku, { arsRate, markupPercent });
  if (!item) notFound();

  return (
    <main className="page narrow">
      <SiteHeader />
      <CheckoutArticulo
        sku={item.sku}
        displayName={item.displayName}
        kind={item.kind}
        price={mxn(item.salePriceMxnCents)}
        priceMxn={item.salePriceMxnCents / 100}
        maxQuantity={item.maxQuantity}
        stockByRegion={item.stockByRegion}
        cancelledNotice={cancelado ? 'No se completó tu pago anterior. Puedes intentarlo de nuevo.' : null}
      />
    </main>
  );
}
