/**
 * Read-only Mercado Pago Checkout Pro lookups for the worker's own
 * reconcile sweep — see runner.ts's `runGatewayReconcile` for why this
 * exists. Narrow on purpose, same spirit as the admin panel's own
 * read-mostly wrapper: this only ever calls `getCharge`, never creates a
 * charge or decides what a payment means (that's `settleGatewayCharge`,
 * via `reconcilePendingGatewayPayments` in @levelup/engine).
 */

import { MercadoPagoGateway } from '@levelup/payments';

export const MERCADOPAGO = 'mercadopago';

export function buildMercadoPagoCheckoutPro(): MercadoPagoGateway | null {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
  const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim();
  if (!accessToken || !webhookSecret) return null;

  // The gateway's own constructor refuses to exist without a webhook secret
  // (see mercadopago.ts's own comment) — this reconcile sweep never takes
  // that path, but the same real secret is already in the shared
  // environment, so satisfying the constructor costs nothing extra.
  return new MercadoPagoGateway({ accessToken, webhookSecret });
}
