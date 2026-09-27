/**
 * Mercado Pago webhook — OXXO and/or SPEI, see lib/mercadopago.ts's own doc
 * comment for which methods are actually on.
 *
 * Point Your Integrations → Webhooks at
 * https://<PUBLIC_DOMAIN>/api/webhooks/mercadopago with the "Pagos (legacy)"
 * and "Órdenes comerciales" events for Checkout Pro.
 *
 * Status codes, same reasoning as the Stripe route:
 *
 *   400  signature failed, or the payment this notification points at no
 *        longer exists. Not retried usefully.
 *   200  handled, a duplicate, or authentic-but-irrelevant. Stop redelivering.
 *   500  something on our side broke. Mercado Pago redelivers this one too.
 */

import { NextResponse } from 'next/server';
import { markPaymentEventProcessed, recordPaymentEvent } from '@levelup/db';
import { getDb } from '../../../../lib/server';
import { applyMercadoPagoReport, getMercadoPago, MERCADOPAGO } from '../../../../lib/mercadopago';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const gateway = getMercadoPago();
  if (!gateway) return NextResponse.json({ error: 'Mercado Pago is not configured' }, { status: 404 });

  // The exact bytes, same reason as Stripe's route — even though Mercado
  // Pago's own signature is not computed over the body, re-serialising here
  // would still be a needless way to diverge from what was actually received.
  const raw = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  const verification = await gateway.verifyWebhook(raw, headers);
  if (!verification.ok) {
    if (verification.reason === 'unsupported_event') {
      return NextResponse.json({ received: true, ignored: true });
    }
    console.warn(`[mercadopago] rejected webhook: ${verification.reason}`);
    return NextResponse.json({ error: verification.reason }, { status: 400 });
  }

  const { event } = verification;

  try {
    const db = getDb();
    const logged = await recordPaymentEvent(db, {
      gateway: MERCADOPAGO,
      eventId: event.eventId,
      eventType: event.type,
      payload: event.raw,
    });
    if (logged.alreadyProcessed) return NextResponse.json({ received: true, duplicate: true });

    if (!event.gatewayChargeId || !event.state) {
      await markPaymentEventProcessed(db, logged.id, null);
      return NextResponse.json({ received: true, ignored: true });
    }

    const applied = await applyMercadoPagoReport({
      gatewayChargeId: event.gatewayChargeId,
      state: event.state,
      amountReceivedCents: event.amountReceivedCents,
      reference: event.reference ?? null,
      // Every payment this gateway ever creates is OXXO or SPEI by
      // construction (createCharge refuses card) — so "pending" alone already
      // means a ticket or a CLABE reference exists, unlike Stripe where
      // pending can also mean a card checkout still in progress.
      voucherIssued: event.state === 'pending',
    });

    await markPaymentEventProcessed(db, logged.id, applied.paymentId);

    console.log(
      `[mercadopago] ${event.type} ${event.gatewayChargeId} -> ` +
        `${applied.orderNumber ?? 'no order'}: ${applied.settlement?.action ?? 'none'}`,
    );
    return NextResponse.json({ received: true });
  } catch (err) {
    // Left unprocessed on purpose, so Mercado Pago's redelivery is not
    // dropped as a duplicate.
    console.error(`[mercadopago] failed handling ${event.eventId}: ${String(err)}`);
    return NextResponse.json({ error: 'temporarily unable to process' }, { status: 500 });
  }
}
