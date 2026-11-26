/**
 * Read-only Stripe lookups for the admin panel — same narrow purpose as
 * this directory's own `mercadopago.ts`: let a manual-review tool ask the
 * gateway directly about an order's payment. Never creates a charge, never
 * applies a report.
 */

import 'server-only';
import { StripeGateway } from '@levelup/payments';

declare global {
  // eslint-disable-next-line no-var
  var __adminStripe: StripeGateway | null | undefined;
}

function build(): StripeGateway | null {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secretKey || !webhookSecret) return null;

  // Same reasoning as the admin's own mercadopago.ts: the constructor
  // refuses to exist without a webhook secret, and this lookup never takes
  // that path, but the real secret is already in the shared environment.
  return new StripeGateway({ secretKey, webhookSecret });
}

/** The configured gateway, or null when Stripe isn't set up at all. */
export function getStripe(): StripeGateway | null {
  if (globalThis.__adminStripe !== undefined) return globalThis.__adminStripe;
  const built = build();
  if (process.env.NODE_ENV !== 'production') globalThis.__adminStripe = built;
  return built;
}
