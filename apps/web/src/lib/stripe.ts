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
import {
  DrizzlePaymentStore,
  extendPaymentDeadline,
  findGatewayPayment,
} from '@levelup/db';
import {
  settleGatewayCharge,
  type GatewayChargeState,
  type GatewaySettlement,
} from '@levelup/engine';
import { getDb } from './server';
import { notifyOps } from './ops';

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

  return new StripeGateway({
    secretKey,
    webhookSecret,
    // OXXO has to be switched on in the Stripe dashboard first; asking for it
    // before then makes every session creation fail. Opt-in for that reason.
    methods: flag(process.env.STRIPE_OXXO) ? ['card', 'oxxo'] : ['card'],
    sessionMinutes: Number(process.env.STRIPE_SESSION_MINUTES ?? 60),
    oxxoExpiresAfterDays: Number(process.env.STRIPE_OXXO_DAYS ?? 2),
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

export interface StripeReport {
  gatewayChargeId: string;
  state: GatewayChargeState;
  amountReceivedCents: number | null;
  reference: string | null;
  /** An OXXO voucher was issued: the money is days away, not seconds. */
  voucherIssued: boolean;
}

export interface AppliedReport {
  paymentId: string | null;
  orderNumber: string | null;
  settlement: GatewaySettlement | null;
}

/**
 * Apply what Stripe says about a session to its order.
 *
 * The order is found by the session id we stored when creating it — never by
 * metadata on the event. Metadata is signed and so not forgeable, but the
 * session id is the link this system itself recorded, and it is the one that
 * cannot point at the wrong order.
 */
export async function applyStripeReport(report: StripeReport): Promise<AppliedReport> {
  const db = getDb();
  const payment = await findGatewayPayment(db, STRIPE, report.gatewayChargeId);

  if (!payment) {
    if (report.state === 'paid') {
      // Money with no order. Rare — it means the session was created and our
      // write linking it failed — but it is someone's real money.
      await notifyOps('critical', 'Pago con tarjeta recibido sin pedido asociado', {
        session: report.gatewayChargeId,
        amountMxn: ((report.amountReceivedCents ?? 0) / 100).toFixed(2),
        reference: report.reference,
      });
    }
    return { paymentId: null, orderNumber: null, settlement: null };
  }

  if (report.state === 'pending' && report.voucherIssued) {
    // The Checkout session expires in an hour; the voucher is payable for
    // days. Move the deadline so the sweep does not retire the order while the
    // customer is on their way to the OXXO.
    const days = getStripe()?.oxxoExpiresAfterDays ?? 2;
    await extendPaymentDeadline(db, payment.paymentId, new Date(Date.now() + (days + 1) * 86_400_000));
  }

  const settlement = await settleGatewayCharge(
    { store: new DrizzlePaymentStore(db) },
    {
      orderId: payment.orderId,
      state: report.state,
      amountReceivedCents: report.amountReceivedCents,
      reference: report.reference,
    },
  );

  if (settlement.action === 'refused') {
    await notifyOps('critical', 'Pago con tarjeta recibido pero NO aprobado — revisar a mano', {
      order: payment.orderNumber,
      code: settlement.failure.code,
      detail: settlement.failure.message,
      reference: report.reference,
    });
  }

  return { paymentId: payment.paymentId, orderNumber: payment.orderNumber, settlement };
}
