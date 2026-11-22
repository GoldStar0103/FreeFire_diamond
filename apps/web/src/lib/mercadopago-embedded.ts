/**
 * Card and/or SPEI through Mercado Pago's embedded Orders API, as the
 * storefront sees them.
 *
 * Kept separate from lib/mercadopago.ts (Checkout Pro — OXXO, and SPEI until
 * this ships) for the same reason the backend adapter is its own file: these
 * are different wire protocols with a different webhook topic, not a branch
 * of the same integration. `MERCADOPAGO_CARD`/`MERCADOPAGO_SPEI_EMBEDDED` are
 * independent flags, off by default, so this can be deployed dark and turned
 * on deliberately once verified in sandbox.
 *
 * Stripe stays wired and dormant through the cutover (see stripe.ts) — this
 * file going live only stops new card charges from choosing Stripe in the UI,
 * it does not remove Stripe's ability to settle a charge already in flight.
 */

import 'server-only';
import { MercadoPagoEmbeddedGateway, type GatewayMethod } from '@levelup/payments';
import { applyGatewayReport, type AppliedReport, type GatewayReport } from './gateway-report';

export const MERCADOPAGO_EMBEDDED = 'mercadopago-embedded';

declare global {
  // eslint-disable-next-line no-var
  var __webMercadoPagoEmbedded: MercadoPagoEmbeddedGateway | null | undefined;
}

const flag = (value: string | undefined) => /^(1|true|yes|si|sí)$/i.test(value?.trim() ?? '');

function build(): MercadoPagoEmbeddedGateway | null {
  // Reuses the same account credentials as lib/mercadopago.ts — same Mercado
  // Pago account, just a different API surface — so there is nothing new to
  // provision beyond the two feature flags below.
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
  const webhookSecret = process.env.MERCADOPAGO_EMBEDDED_WEBHOOK_SECRET?.trim();
  if (!accessToken || !webhookSecret) return null;

  const methods: Extract<GatewayMethod, 'card' | 'spei'>[] = [];
  if (flag(process.env.MERCADOPAGO_CARD)) methods.push('card');
  if (flag(process.env.MERCADOPAGO_SPEI_EMBEDDED)) methods.push('spei');
  if (methods.length === 0) return null;

  return new MercadoPagoEmbeddedGateway({ accessToken, webhookSecret, methods });
}

/** The configured gateway, or null when neither embedded method is on. */
export function getMercadoPagoEmbedded(): MercadoPagoEmbeddedGateway | null {
  if (globalThis.__webMercadoPagoEmbedded !== undefined) return globalThis.__webMercadoPagoEmbedded;
  const built = build();
  if (process.env.NODE_ENV !== 'production') globalThis.__webMercadoPagoEmbedded = built;
  return built;
}

/**
 * Same order-of-magnitude grace as Checkout Pro's SPEI (see
 * lib/mercadopago.ts's own comment) — kept as its own env var rather than
 * reusing MERCADOPAGO_PENDING_DAYS so the two integrations can be tuned
 * independently if the embedded flow's real-world settlement time turns out
 * to differ once it's actually seen in production.
 */
const PENDING_GRACE_DAYS = Number(process.env.MERCADOPAGO_EMBEDDED_PENDING_DAYS ?? 3);

export type MercadoPagoEmbeddedReport = GatewayReport;
export type { AppliedReport };

/**
 * Apply what Mercado Pago's embedded flow says about a charge to its order.
 *
 * `voucherIssued` here must never be computed from `state === 'pending'`
 * alone the way the legacy Checkout-Pro route does — that shortcut is only
 * correct there because that route never sees a card event (createCharge
 * refuses card outright). This route serves both card and SPEI, and a card
 * charge can sit `pending` while waiting on 3DS/issuer review, which is not a
 * voucher and must not get its payment deadline silently extended by days.
 */
export async function applyMercadoPagoEmbeddedReport(
  report: MercadoPagoEmbeddedReport,
): Promise<AppliedReport> {
  return applyGatewayReport(MERCADOPAGO_EMBEDDED, report, PENDING_GRACE_DAYS);
}
