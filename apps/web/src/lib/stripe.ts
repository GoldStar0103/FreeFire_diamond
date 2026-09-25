/**
 * Card payments through Stripe, as the storefront sees them.
 *
 * Off unless both keys are set. The manual comprobante flow is what the
 * business already runs on, so a half-configured Stripe must not replace it —
 * it simply does not appear, and checkout carries on as before.
 *
 * Two paths confirm a card payment, and both end in the same engine call:
 *
 *   1. The webhook, which is the real one.
 *   2. The customer landing back on their order page, where we ask Stripe
 *      directly. That covers a webhook that is late, misconfigured, or was
 *      pointed at the wrong URL during setup — which on a first deployment is
 *      the likeliest failure of all. Never trust the webhook as the only path.
 *
 * `approvePayment` is idempotent, so both firing is one approval.
 */

import 'server-only';
import { StripeGateway } from '@levelup/payments';
import { applyGatewayReport, type AppliedReport, type GatewayReport } from './gateway-report';

export const STRIPE = 'stripe';

declare global {
  // eslint-disable-next-line no-var
  var __webStripe: StripeGateway | null | undefined;
}

const flag = (value: string | undefined) => /^(1|true|yes|si|sí)$/i.test(value?.trim() ?? '');

function build(): StripeGateway | null {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secretKey || !webhookSecret) return null;

  // OXXO and SPEI each have to be switched on in the Stripe dashboard (in
  // whichever mode — test/live — this key belongs to) before asking Checkout
  // for them; otherwise Stripe silently drops the unsupported entry rather
  // than rejecting the session, which reads as "the button does nothing" for
  // that method. Opt-in for that reason, one flag per method.
  const methods: Array<'card' | 'oxxo' | 'spei'> = ['card'];
  if (flag(process.env.STRIPE_OXXO)) methods.push('oxxo');
  if (flag(process.env.STRIPE_SPEI)) methods.push('spei');

  return new StripeGateway({
    secretKey,
    webhookSecret,
    methods,
    sessionMinutes: Number(process.env.STRIPE_SESSION_MINUTES ?? 60),
    oxxoExpiresAfterDays: Number(process.env.STRIPE_OXXO_DAYS ?? 2),
    speiGraceDays: Number(process.env.STRIPE_SPEI_DAYS ?? 3),
  });
}

/** The configured gateway, or null when card payments are off. */
export function getStripe(): StripeGateway | null {
  if (globalThis.__webStripe !== undefined) return globalThis.__webStripe;
  const built = build();
  if (process.env.NODE_ENV !== 'production') globalThis.__webStripe = built;
  return built;
}

/** How long past the session's own expiry our payment row waits before the sweep retires it. */
export const SESSION_GRACE_MS = 30 * 60_000;

export type StripeReport = GatewayReport;
export type { AppliedReport };

/**
 * Apply what Stripe says about a session to its order — see
 * `applyGatewayReport`'s own doc comment for why this and Mercado Pago's
 * equivalent share one implementation.
 */
export async function applyStripeReport(report: StripeReport): Promise<AppliedReport> {
  return applyGatewayReport(STRIPE, report, getStripe()?.pendingGraceDays ?? 2);
}
