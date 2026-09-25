/**
 * OXXO through Mercado Pago, as the storefront sees it.
 *
 * Card and SPEI stay on Stripe — this exists specifically because Stripe's
 * own OXXO settlement (via PPRO) proved unreliable in production: real
 * vouchers, really paid, sometimes taking most of a day or more to report
 * back (confirmed with Stripe support, see stuck-payments.ts). The client
 * asked to move OXXO to Mercado Pago while leaving the other two alone.
 *
 * Off unless both keys are set — same rule as Stripe: a half-configured
 * Mercado Pago must not replace the manual comprobante flow, it simply does
 * not appear.
 */

import 'server-only';
import { MercadoPagoGateway } from '@levelup/payments';
import { applyGatewayReport, type AppliedReport, type GatewayReport } from './gateway-report';

export const MERCADOPAGO = 'mercadopago';

declare global {
  // eslint-disable-next-line no-var
  var __webMercadoPago: MercadoPagoGateway | null | undefined;
}

function build(): MercadoPagoGateway | null {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
  const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim();
  if (!accessToken || !webhookSecret) return null;

  return new MercadoPagoGateway({
    accessToken,
    webhookSecret,
    methods: ['oxxo'],
  });
}

/** The configured gateway, or null when Mercado Pago OXXO is off. */
export function getMercadoPago(): MercadoPagoGateway | null {
  if (globalThis.__webMercadoPago !== undefined) return globalThis.__webMercadoPago;
  const built = build();
  if (process.env.NODE_ENV !== 'production') globalThis.__webMercadoPago = built;
  return built;
}

/** How many days our own payment deadline is extended once an OXXO ticket is issued. */
const OXXO_GRACE_DAYS = Number(process.env.MERCADOPAGO_OXXO_DAYS ?? 3);

export type MercadoPagoReport = GatewayReport;
export type { AppliedReport };

/**
 * Apply what Mercado Pago says about a payment to its order — see
 * `applyGatewayReport`'s own doc comment for why this and Stripe's
 * equivalent share one implementation.
 */
export async function applyMercadoPagoReport(report: MercadoPagoReport): Promise<AppliedReport> {
  return applyGatewayReport(MERCADOPAGO, report, OXXO_GRACE_DAYS);
}
