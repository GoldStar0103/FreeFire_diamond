/**
 * Read-only Mercado Pago Embedded (Orders API) lookups for the admin panel —
 * the embedded-gateway sibling of this directory's own `mercadopago.ts`
 * (Checkout Pro), same narrow purpose: let "Verificar con Mercado Pago" ask
 * the gateway directly about an order's payment. Never creates a charge,
 * never applies a report.
 */

import 'server-only';
import { MercadoPagoEmbeddedGateway } from '@levelup/payments';

declare global {
  // eslint-disable-next-line no-var
  var __adminMercadoPagoEmbedded: MercadoPagoEmbeddedGateway | null | undefined;
}

function build(): MercadoPagoEmbeddedGateway | null {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
  const webhookSecret = process.env.MERCADOPAGO_EMBEDDED_WEBHOOK_SECRET?.trim();
  if (!accessToken || !webhookSecret) return null;

  return new MercadoPagoEmbeddedGateway({ accessToken, webhookSecret, methods: ['card', 'spei'] });
}

/** The configured gateway, or null when the embedded flow isn't set up at all. */
export function getMercadoPagoEmbedded(): MercadoPagoEmbeddedGateway | null {
  if (globalThis.__adminMercadoPagoEmbedded !== undefined) return globalThis.__adminMercadoPagoEmbedded;
  const built = build();
  if (process.env.NODE_ENV !== 'production') globalThis.__adminMercadoPagoEmbedded = built;
  return built;
}
