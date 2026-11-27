/**
 * Read-only Stripe lookups for the worker's own reconcile sweep — see
 * runner.ts's `runGatewayReconcile`. Mirrors mercadopago.ts's own build
 * helper: narrow on purpose, this only ever calls `getCharge`, never creates
 * a charge or decides what a payment means.
 *
 * Built 2026-11-27 — Stripe's embedded card flow (see @levelup/payments'
 * stripe.ts doc comment, "card moved off hosted Checkout 2026-11-26") only
 * ever settles through the webhook or the customer reloading their own order
 * page (apps/web/src/lib/stripe.ts's own doc comment names exactly these two
 * paths and no third one). A customer who authorizes a card — including a
 * real-world 3D Secure/bank-OTP step, which can take several minutes — and
 * then closes the tab without it ever reloading has no path left if the
 * webhook is also late or missed, same gap Mercado Pago's Checkout Pro hit
 * in production on 2026-11-26 (see gateway-reconcile.ts's own doc comment)
 * and was given this exact sweep for. Stripe never got the same sweep when
 * card moved to the embedded flow; confirmed in production 2026-11-27 via
 * Jose's own reports — card payments that authorized fine (Stripe's
 * dashboard shows `pi_...` succeeding) but arrived as `NOT_AWAITING_PAYMENT
 * / ... is expired` because nothing re-checked Stripe directly before the
 * sweep's own `expireOverduePayments` retired the order first.
 */

import { StripeGateway } from '@levelup/payments';

export const STRIPE = 'stripe';

export function buildStripeCheck(): StripeGateway | null {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secretKey || !webhookSecret) return null;

  return new StripeGateway({ secretKey, webhookSecret });
}
