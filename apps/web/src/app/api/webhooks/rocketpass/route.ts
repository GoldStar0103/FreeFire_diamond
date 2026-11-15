/**
 * RocketPass webhook.
 *
 * Point RocketPass's license settings at
 * https://<PUBLIC_DOMAIN>/api/webhooks/rocketpass for: order.delivered,
 * order.partial, order.failed, contract.expiring, contract.expired,
 * contract.renewed, balance.low.
 *
 * This is the vendor-fulfilment side, not the payment side — a RocketPass
 * order only ever reaches `PENDING`/`PROCESSING` from the initial
 * `POST /orders` call (see `fulfillItemOrder`), and this is what settles it
 * from there. It has nothing to do with how the order was paid for (card,
 * SPEI, manual transfer) — that's the same Stripe/Mercado Pago/comprobante
 * pipeline every diamond order already uses.
 *
 * Status codes mirror the Stripe/Mercado Pago routes' own reasoning:
 *
 *   400  signature failed. Not retried usefully — and not our problem to fix.
 *   200  handled, a duplicate, an unrecognised order id, or an event type we
 *        don't act on. Stop sending it.
 *   500  something on our side broke. RocketPass retries at 30s/2m/10m/30m/2h
 *        (see its own docs), and the event log lets the redelivery finish.
 */

import { NextResponse } from 'next/server';
import { DrizzleItemFulfillmentStore, markPaymentEventProcessed, recordPaymentEvent } from '@levelup/db';
import { applyRocketPassWebhookOrder } from '@levelup/engine';
import { verifyRocketPassWebhook } from '@levelup/rocketpass';
import { getDb } from '../../../../lib/server';
import { getRocketPassWebhookSecret, rocketpassAlerter, ROCKETPASS } from '../../../../lib/rocketpass';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** How many attempts `decideItemFulfillment` is told this order has had — irrelevant to every branch a webhook settlement actually takes (it only matters for a failed *placement* call), kept only so the function's shape stays identical to the synchronous path. */
const WEBHOOK_MAX_ATTEMPTS = 3;

export async function POST(request: Request): Promise<Response> {
  const secret = getRocketPassWebhookSecret();
  if (!secret) return NextResponse.json({ error: 'RocketPass webhooks are not configured' }, { status: 404 });

  // The exact bytes — the signature is over these, and a parse-and-restringify
  // would never match it.
  const raw = await request.text();
  const signature = request.headers.get('x-rocketpass-signature') ?? undefined;

  const verification = verifyRocketPassWebhook(raw, signature, secret);
  if (!verification.ok) {
    console.warn(`[rocketpass] rejected webhook: ${verification.reason}`);
    return NextResponse.json({ error: verification.reason }, { status: 400 });
  }

  const { event } = verification;

  try {
    const db = getDb();
    const logged = await recordPaymentEvent(db, {
      gateway: ROCKETPASS,
      eventId: event.id,
      eventType: event.type,
      payload: event,
    });
    if (logged.alreadyProcessed) return NextResponse.json({ received: true, duplicate: true });

    switch (event.type) {
      case 'order.delivered':
      case 'order.partial':
      case 'order.failed': {
        const order = event.data.order;
        if (!order) {
          await markPaymentEventProcessed(db, logged.id, null);
          return NextResponse.json({ received: true, ignored: true });
        }

        const outcome = await applyRocketPassWebhookOrder(
          {
            store: new DrizzleItemFulfillmentStore(db),
            alerter: rocketpassAlerter,
            config: { maxAttempts: WEBHOOK_MAX_ATTEMPTS },
          },
          { rocketpassOrderId: order.orderId, status: order.status },
        );

        await markPaymentEventProcessed(db, logged.id, null);
        console.log(`[rocketpass] ${event.type} ${order.orderId} -> ${outcome.kind}`);
        if (outcome.kind === 'unrecognised') {
          console.warn(`[rocketpass] webhook for an order id we never placed: ${order.orderId}`);
        }
        return NextResponse.json({ received: true });
      }

      case 'balance.low': {
        await rocketpassAlerter.send('critical', 'Saldo bajo en RocketPass', {
          balanceArs: event.data.balance?.balanceArs,
          thresholdArs: event.data.balance?.thresholdArs,
        });
        await markPaymentEventProcessed(db, logged.id, null);
        return NextResponse.json({ received: true });
      }

      case 'contract.expiring':
      case 'contract.expired': {
        await rocketpassAlerter.send(
          'critical',
          event.type === 'contract.expired' ? 'Contrato de RocketPass vencido' : 'Contrato de RocketPass por vencer',
          { expiresAt: event.data.contract?.expiresAt, daysLeft: event.data.contract?.daysLeft },
        );
        await markPaymentEventProcessed(db, logged.id, null);
        return NextResponse.json({ received: true });
      }

      case 'contract.renewed': {
        console.log(`[rocketpass] contract renewed, expires ${event.data.contract?.expiresAt ?? 'unknown'}`);
        await markPaymentEventProcessed(db, logged.id, null);
        return NextResponse.json({ received: true });
      }

      default: {
        await markPaymentEventProcessed(db, logged.id, null);
        return NextResponse.json({ received: true, ignored: true });
      }
    }
  } catch (err) {
    // Left unprocessed on purpose, so RocketPass's redelivery is not dropped
    // as a duplicate.
    console.error(`[rocketpass] failed handling ${event.id}: ${String(err)}`);
    return NextResponse.json({ error: 'temporarily unable to process' }, { status: 500 });
  }
}
