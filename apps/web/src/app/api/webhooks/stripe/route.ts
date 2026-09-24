/**
 * Stripe webhook.
 *
 * Point the Stripe dashboard at https://<PUBLIC_DOMAIN>/api/webhooks/stripe
 * with these events: checkout.session.completed,
 * checkout.session.async_payment_succeeded,
 * checkout.session.async_payment_failed, checkout.session.expired.
 *
 * Status codes are how we talk to Stripe's retry logic, so they are chosen
 * carefully:
 *
 *   400  signature failed. Not retried usefully — and not our problem to fix.
 *   200  handled, a duplicate, or authentic-but-irrelevant. Stop sending it.
 *   500  something on our side broke. Stripe redelivers for up to three days,
 *        and the event log lets the redelivery finish the job.
 */

import { NextResponse } from 'next/server';
import { markPaymentEventProcessed, recordPaymentEvent } from '@levelup/db';
import { getDb } from '../../../../lib/server';
import { applyStripeReport, getStripe, STRIPE } from '../../../../lib/stripe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const gateway = getStripe();
  if (!gateway) return NextResponse.json({ error: 'card payments are not configured' }, { status: 404 });

  // The exact bytes. The signature is over these, and a parse-and-restringify
  // would never match it.
  const raw = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  const verification = await gateway.verifyWebhook(raw, headers);
  if (!verification.ok) {
    if (verification.reason === 'unsupported_event') {
      return NextResponse.json({ received: true, ignored: true });
    }
    console.warn(`[stripe] rejected webhook: ${verification.reason}`);
    return NextResponse.json({ error: verification.reason }, { status: 400 });
  }

  const { event } = verification;

  try {
    const db = getDb();
    const logged = await recordPaymentEvent(db, {
      gateway: STRIPE,
      eventId: event.eventId,
      eventType: event.type,
      payload: event.raw,
    });
    if (logged.alreadyProcessed) return NextResponse.json({ received: true, duplicate: true });

    if (!event.gatewayChargeId || !event.state) {
      await markPaymentEventProcessed(db, logged.id, null);
      return NextResponse.json({ received: true, ignored: true });
    }

    const applied = await applyStripeReport({
      gatewayChargeId: event.gatewayChargeId,
      state: event.state,
      amountReceivedCents: event.amountReceivedCents,
      reference: event.reference ?? null,
      voucherIssued: event.type === 'checkout.session.completed' && event.state === 'pending',
    });

    await markPaymentEventProcessed(db, logged.id, applied.paymentId);

    console.log(
      `[stripe] ${event.type} ${event.gatewayChargeId} -> ` +
        `${applied.orderNumber ?? 'no order'}: ${applied.settlement?.action ?? 'none'}`,
    );
    return NextResponse.json({ received: true });
  } catch (err) {
    // Left unprocessed on purpose, so Stripe's redelivery is not dropped as a
    // duplicate.
    console.error(`[stripe] failed handling ${event.eventId}: ${String(err)}`);
    return NextResponse.json({ error: 'temporarily unable to process' }, { status: 500 });
  }
}
