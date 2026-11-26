import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getStorefrontItem } from '@levelup/db';
import { getDb } from '../../../lib/server';
import { mxn } from '../../../lib/format';
import { getMercadoPago } from '../../../lib/mercadopago';
import { getMercadoPagoEmbedded } from '../../../lib/mercadopago-embedded';
import { SiteHeader } from '../../site-header';
import { CheckoutArticulo } from './checkout-articulo';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ sku: string }>;
}): Promise<Metadata> {
  const { sku } = await params;
  const item = await getStorefrontItem(getDb(), sku);
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

  const item = await getStorefrontItem(getDb(), sku);
  if (!item) notFound();

  const mercadoPago = getMercadoPago();
  const mercadoPagoEmbedded = getMercadoPagoEmbedded();

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
        mercadoPagoCardCheckoutProEnabled={mercadoPago?.supportedMethods.includes('card') ?? false}
        mercadoPagoCardEnabled={mercadoPagoEmbedded?.supportedMethods.includes('card') ?? false}
        mercadoPagoPublicKey={process.env.NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY ?? null}
        stripePublishableKey={process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null}
      />
    </main>
  );
}
