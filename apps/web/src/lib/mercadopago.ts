/**
 * OXXO and/or SPEI through Mercado Pago, as the storefront sees them.
 *
 * Card always stays on Stripe. OXXO and SPEI each moved here independently
 * (on different dates) for the same reason: Stripe's own Mexico local-payment
 * settlement (via PPRO) proved unreliable in production — real vouchers and
 * real transfers, really paid, sometimes taking most of a day (or, for SPEI,
 * longer) to report back (confirmed with Stripe support, see
 * stuck-payments.ts). `MERCADOPAGO_OXXO`/`MERCADOPAGO_SPEI` are independent
 * flags for exactly this reason: the client has already said either one might
 * move back to Stripe on its own if Mercado Pago turns out no better — that
 * should be an env-flag flip on both sides, not a redeploy of this file.
 *
 * Off unless both keys are set — same rule as Stripe: a half-configured
 * Mercado Pago must not replace the manual comprobante flow, it simply does
 * not appear. With keys set but neither method flag on, it is equivalent to
 * being unconfigured.
 */

import 'server-only';
import { MercadoPagoGateway, type GatewayMethod } from '@levelup/payments';
import { applyGatewayReport, type AppliedReport, type GatewayReport } from './gateway-report';

export const MERCADOPAGO = 'mercadopago';

declare global {
  // eslint-disable-next-line no-var
  var __webMercadoPago: MercadoPagoGateway | null | undefined;
}

const flag = (value: string | undefined) => /^(1|true|yes|si|sí)$/i.test(value?.trim() ?? '');

function build(): MercadoPagoGateway | null {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
  const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim();
  if (!accessToken || !webhookSecret) return null;

  const methods: Extract<GatewayMethod, 'oxxo' | 'spei'>[] = [];
  if (flag(process.env.MERCADOPAGO_OXXO)) methods.push('oxxo');
  if (flag(process.env.MERCADOPAGO_SPEI)) methods.push('spei');
  if (methods.length === 0) return null;

  return new MercadoPagoGateway({
    accessToken,
    webhookSecret,
    methods,
  });
}

/** The configured gateway, or null when neither Mercado Pago method is on. */
export function getMercadoPago(): MercadoPagoGateway | null {
  if (globalThis.__webMercadoPago !== undefined) return globalThis.__webMercadoPago;
  const built = build();
  if (process.env.NODE_ENV !== 'production') globalThis.__webMercadoPago = built;
  return built;
}

/**
 * How many days our own payment deadline is extended once an OXXO ticket or
 * SPEI reference is issued. Mercado Pago's own published guidance recommends
 * a 3-day SPEI reference window "to avoid conflicts between the expiration
 * date and the payment crediting" — the same order of magnitude as OXXO's own
 * grace period, so one shared setting covers both rather than splitting it
 * the way Stripe's adapter does (which needed two because it configures each
 * method's expiry on Stripe's side; Mercado Pago's own expiry is read off the
 * Payment after the fact instead, so there is nothing to configure per method
 * here — see createCharge's own comment on that in mercadopago.ts).
 */
const PENDING_GRACE_DAYS = Number(process.env.MERCADOPAGO_PENDING_DAYS ?? 3);

export type MercadoPagoReport = GatewayReport;
export type { AppliedReport };

/**
 * Apply what Mercado Pago says about a payment to its order — see
 * `applyGatewayReport`'s own doc comment for why this and Stripe's
 * equivalent share one implementation.
 */
export async function applyMercadoPagoReport(report: MercadoPagoReport): Promise<AppliedReport> {
  return applyGatewayReport(MERCADOPAGO, report, PENDING_GRACE_DAYS);
}
