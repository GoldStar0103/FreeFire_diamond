/**
 * Mercado Pago embedded-checkout webhook — card and/or SPEI via the Orders
 * API, see lib/mercadopago-embedded.ts's own doc comment for which methods
 * are actually on. Separate route/topic from the Checkout-Pro webhook at
 * /api/webhooks/mercadopago — see mercadopago-embedded.ts in @levelup/payments
 * for why these are two different integrations, not one.
 *
 * Point Your Integrations → Webhooks at
 * https://<PUBLIC_DOMAIN>/api/webhooks/mercadopago-embedded with the
 * "Órdenes comerciales" (orders) topic.
 *
 * Status codes, same reasoning as the other two webhook routes:
 *
 *   400  signature failed, or the order this notification points at no
 *        longer exists. Not retried usefully.
 *   200  handled, a duplicate, or authentic-but-irrelevant. Stop redelivering.
 *   500  something on our side broke. Mercado Pago redelivers this one too.
 */

import { NextResponse } from 'next/server';
import { markPaymentEventProcessed, recordPaymentEvent } from '@levelup/db';
import { getDb } from '../../../../lib/server';
import {
  applyMercadoPagoEmbeddedReport,
  getMercadoPagoEmbedded,
  MERCADOPAGO_EMBEDDED,
} from '../../../../lib/mercadopago-embedded';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The shape mercadopago-embedded.ts's own `verifyWebhook` puts in `event.raw`. */
interface EmbeddedWebhookRaw {
  order?: {
    transactions?: { payments?: Array<{ payment_method?: { type?: string } }> };
  };
}

export async function POST(request: Request): Promise<Response> {
  const gateway = getMercadoPagoEmbedded();
  if (!gateway) return NextResponse.json({ error: 'embedded Mercado Pago is not configured' }, { status: 404 });

  const raw = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  const verification = await gateway.verifyWebhook(raw, headers);
  if (!verification.ok) {
    if (verification.reason === 'unsupported_event') {
      return NextResponse.json({ received: true, ignored: true });
    }
    console.warn(`[mercadopago-embedded] rejected webhook: ${verification.reason}`);
    return NextResponse.json({ error: verification.reason }, { status: 400 });
  }

  const { event } = verification;

  try {
    const db = getDb();
    const logged = await recordPaymentEvent(db, {
      gateway: MERCADOPAGO_EMBEDDED,
      eventId: event.eventId,
      eventType: event.type,
      payload: event.raw,
    });
    if (logged.alreadyProcessed) return NextResponse.json({ received: true, duplicate: true });

    if (!event.gatewayChargeId || !event.state) {
      await markPaymentEventProcessed(db, logged.id, null);
      return NextResponse.json({ received: true, ignored: true });
    }

    // Deliberately NOT `event.state === 'pending'` alone — this route serves
    // both card and SPEI, unlike the Checkout-Pro route this one is modeled
    // on, which gets away with that shortcut only because it never sees a
    // card event at all. A card pending on 3DS/issuer review is not a
    // voucher and must not have its deadline silently extended by days.
    const paymentMethodType = (event.raw as EmbeddedWebhookRaw)?.order?.transactions?.payments?.[0]
      ?.payment_method?.type;
    const voucherIssued = event.state === 'pending' && paymentMethodType === 'bank_transfer';

    const applied = await applyMercadoPagoEmbeddedReport({
      gatewayChargeId: event.gatewayChargeId,
      state: event.state,
      amountReceivedCents: event.amountReceivedCents,
      reference: event.reference ?? null,
      voucherIssued,
    });

    await markPaymentEventProcessed(db, logged.id, applied.paymentId);

    console.log(
      `[mercadopago-embedded] ${event.type} ${event.gatewayChargeId} -> ` +
        `${applied.orderNumber ?? 'no order'}: ${applied.settlement?.action ?? 'none'}`,
    );
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error(`[mercadopago-embedded] failed handling ${event.eventId}: ${String(err)}`);
    return NextResponse.json({ error: 'temporarily unable to process' }, { status: 500 });
  }
}
