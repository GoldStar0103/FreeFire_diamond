import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  findCustomerOrder,
  getPaymentDetails,
  getPaymentMethodsEnabled,
  getStorefrontCombo,
} from '@levelup/db';
import { getDb } from '../../../lib/server';
import { applyStripeReport, getStripe, STRIPE } from '../../../lib/stripe';
import { getMercadoPago } from '../../../lib/mercadopago';
import { diamonds, mxn } from '../../../lib/format';
import { supportNumber } from '../../../lib/support';
import { Checkout } from './checkout';

export const dynamic = 'force-dynamic';

/**
 * Titles and descriptions per offer, matching the generated preview card next
 * door. A link shared into a group should say what it is in the tab, in the
 * card and in search results — not "LevelUp Store" three times.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ combo: string }>;
}): Promise<Metadata> {
  const { combo: comboKey } = await params;
  const combo = await getStorefrontCombo(getDb(), comboKey);

  if (!combo) return { title: 'Paquete no disponible' };

  const title = `${combo.name} — ${diamonds(combo.advertisedDiamonds)} diamantes`;
  const description =
    `${diamonds(combo.advertisedDiamonds)} diamantes de Free Fire por ` +
    `${mxn(combo.priceMxnCents)}. Entrega automática a tu cuenta, sin contraseñas.`;

  return {
    title,
    description,
    alternates: { canonical: `/comprar/${combo.key}` },
    openGraph: {
      type: 'website',
      title,
      description,
      url: `/comprar/${combo.key}`,
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

/**
 * The customer pressed "back" on Stripe's page.
 *
 * Their order was created before they left, so it is holding their Mega
 * Oferta slot. Expire the session at Stripe and the order here, and they can
 * try again straight away instead of being told for an hour that they already
 * used the offer.
 *
 * Authorised the same way the order page is — order number plus player ID —
 * and Stripe itself refuses to expire a session that has been paid or has
 * issued an OXXO voucher, so this can never void a payment in flight. If that
 * is what happened, they are sent to their order instead.
 */
async function handleCancelledCheckout(orderNumber: string, playerId: string): Promise<string | null> {
  const gateway = getStripe();
  const order = await findCustomerOrder(getDb(), orderNumber, playerId);
  if (!gateway || !order || order.gateway !== STRIPE || !order.gatewayChargeId) return null;
  if (order.status !== 'esperando_pago') return null;

  let paidAfterAll = false;
  try {
    if ((await gateway.expireSession(order.gatewayChargeId)) === 'expired') {
      await applyStripeReport({
        gatewayChargeId: order.gatewayChargeId,
        state: 'expired',
        amountReceivedCents: null,
        reference: null,
        voucherIssued: false,
      });
    } else {
      const snapshot = await gateway.getCharge(order.gatewayChargeId);
      if (snapshot) {
        const issued = Boolean(snapshot.voucherUrl) || Boolean(snapshot.bankTransfer);
        await applyStripeReport({
          gatewayChargeId: snapshot.gatewayChargeId,
          state: snapshot.state,
          amountReceivedCents: snapshot.amountReceivedCents,
          reference: snapshot.reference ?? null,
          voucherIssued: issued,
        });
        paidAfterAll = snapshot.state === 'paid' || issued;
      }
    }
  } catch (err) {
    // The session lapses on its own within the hour and the sweep follows.
    console.error(`[checkout] could not close cancelled session for ${orderNumber}`, err);
  }

  if (paidAfterAll) {
    redirect(`/pedido/${order.orderNumber}?id=${encodeURIComponent(order.playerId)}`);
  }
  return 'No se completó el pago y no se te cobró nada. Puedes intentarlo de nuevo.';
}

export default async function BuyPage({
  params,
  searchParams,
}: {
  params: Promise<{ combo: string }>;
  searchParams: Promise<{ cancelado?: string; id?: string }>;
}) {
  const { combo: comboKey } = await params;
  const { cancelado, id } = await searchParams;

  const cancelledNotice =
    cancelado && id ? await handleCancelledCheckout(cancelado, id) : null;

  const [combo, payTo, methodsEnabled] = await Promise.all([
    getStorefrontCombo(getDb(), comboKey),
    getPaymentDetails(getDb()),
    getPaymentMethodsEnabled(getDb()),
  ]);

  if (!combo) notFound();

  const stripe = getStripe();
  const mercadoPago = getMercadoPago();

  // Null means nobody has configured where the money goes. Previously these
  // were environment variables defaulting to empty strings, so an
  // unconfigured deployment rendered a blank account number to a customer who
  // had just confirmed their Free Fire ID and was reaching for their banking
  // app. Say so instead, and log it where an operator will see it.
  if (!payTo && !stripe) {
    console.error(
      '[checkout] No payment details configured. Set them in the admin panel ' +
        'under Ajustes — the storefront cannot take bank transfers until then.',
    );
  }

  return (
    <main className="page narrow">
      <Link href="/" className="back">
        ← Volver
      </Link>

      <Checkout
        comboKey={combo.key}
        comboName={combo.name}
        price={mxn(combo.priceMxnCents)}
        priceMxn={combo.priceMxnCents / 100}
        diamonds={diamonds(combo.advertisedDiamonds)}
        payTo={payTo}
        cardEnabled={stripe !== null && methodsEnabled.card}
        cardIncludesOxxo={stripe?.supportedMethods.includes('oxxo') ?? false}
        cardIncludesSpei={stripe?.supportedMethods.includes('spei') ?? false}
        mercadoPagoOxxoEnabled={mercadoPago?.supportedMethods.includes('oxxo') ?? false}
        transferEnabled={methodsEnabled.transfer}
        oxxoEnabled={methodsEnabled.oxxo}
        cancelledNotice={cancelledNotice}
        supportNumber={supportNumber() ?? ''}
      />
    </main>
  );
}
