/**
 * Read-only Mercado Pago lookups for the admin panel.
 *
 * The storefront's own apps/web/src/lib/mercadopago.ts builds this same
 * gateway to actually create and reconcile charges; this is the admin
 * side's much narrower need — look up what Mercado Pago itself says about
 * an already-placed order's payment, so a dispute ("the customer says they
 * paid") can be checked against the gateway directly instead of only our
 * own recorded state. Never creates a charge, never applies a report.
 */

import 'server-only';
import { MercadoPagoGateway } from '@levelup/payments';

declare global {
  // eslint-disable-next-line no-var
  var __adminMercadoPago: MercadoPagoGateway | null | undefined;
}

function build(): MercadoPagoGateway | null {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
  const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim();
  if (!accessToken || !webhookSecret) return null;

  // The gateway's own constructor refuses to exist without a webhook
  // secret (see mercadopago.ts's own comment: it must always be able to
  // verify who is telling it money arrived) — this admin lookup never
  // uses that path, but the same real secret is already in the shared
  // environment, so satisfying the constructor costs nothing extra.
  return new MercadoPagoGateway({ accessToken, webhookSecret, methods: ['oxxo'] });
}

/** The configured gateway, or null when Mercado Pago isn't set up at all. */
export function getMercadoPago(): MercadoPagoGateway | null {
  if (globalThis.__adminMercadoPago !== undefined) return globalThis.__adminMercadoPago;
  const built = build();
  if (process.env.NODE_ENV !== 'production') globalThis.__adminMercadoPago = built;
  return built;
}
