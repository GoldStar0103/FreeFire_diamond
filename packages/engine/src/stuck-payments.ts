/**
 * Flagging a Stripe/Mercado Pago OXXO/SPEI payment nobody has heard about in
 * a while.
 *
 * Real incident, 2026-09-23/24: three separate real OXXO deposits — vouchers
 * issued, cash paid at the store, receipts in hand — sat unconfirmed on
 * Stripe's side for hours. The delay was on Stripe's own OXXO settlement (via
 * PPRO), not anything in this codebase, and there was nothing to fix in the
 * payment flow itself. But nothing here was watching for that pattern either
 * — the only reason it surfaced was the customer noticing and asking. This
 * sweep is what should have said so first: it does not resolve anything (it
 * cannot — the money genuinely has not arrived yet), it just tells a human to
 * go check with the gateway's support before a customer has to ask why their
 * diamonds have not shown up.
 *
 * Mercado Pago's OXXO channel (added to replace Stripe's for the same
 * reliability reason) settles through the same PPRO pipeline underneath, so
 * it gets the same watch — this is not Stripe-specific by design, only by
 * where the first incident happened to occur.
 *
 * Deliberately narrow: only 'oxxo' and 'spei', because those are exactly the
 * two methods where the gateway itself has already reported the payment as
 * pending-with-instructions (`voucherIssued` in stripe.ts/mercadopago.ts's own
 * terms) and then gone quiet for an unusual stretch. A card payment either
 * settles in seconds or the customer abandoned the checkout page — expiry,
 * not this, is the right net for that one.
 *
 * Not called from the worker sweep any more (client request, 2026-09-27):
 * the large majority of what it flagged turned out to be customers who
 * generated an OXXO/SPEI reference with no real intention of paying it, not
 * a genuine settlement problem, so the Telegram alert was mostly noise.
 * `listStuckGatewayPayments` (admin-queries.ts) still shows the same list on
 * the Inicio dashboard, with its own dismiss button, for the client to check
 * by hand instead. This function is kept, unused, in case the alert needs to
 * come back.
 */

export interface StuckGatewayPayment {
  orderId: string;
  paymentId: string;
  orderNumber: string;
  /** 'stripe' | 'mercadopago' — which gateway's support to go check with. */
  gateway: string;
  /** 'oxxo' | 'spei' — the only two methods this ever watches. */
  method: string;
  amountExpectedCents: number;
  /** How long it has been sitting unconfirmed, for the alert text. */
  pendingHours: number;
}

const GATEWAY_LABEL: Record<string, string> = {
  stripe: 'Stripe',
  mercadopago: 'Mercado Pago',
};

export interface StuckPaymentStore {
  /**
   * Stripe-gateway oxxo/spei payments still `pending`, created before
   * `olderThan`, that have never been alerted on. The filtering belongs in
   * the query so a caller cannot accidentally widen it — same discipline
   * `ExpiryStore.findOverduePayments` already holds.
   */
  findStuckGatewayPayments(olderThan: Date, limit: number): Promise<StuckGatewayPayment[]>;
  /** Marks it alerted so the next sweep does not send the same warning again. */
  markStuckAlertSent(paymentId: string): Promise<void>;
}

export interface StuckPaymentDeps {
  store: StuckPaymentStore;
  alerter: { send(level: 'info' | 'warn' | 'critical', title: string, detail?: Record<string, unknown>): Promise<void> };
  config: {
    /** How long a pending OXXO/SPEI payment gets before this flags it. */
    olderThanHours: number;
    batchSize: number;
  };
  now?: () => Date;
}

export interface StuckPaymentResult {
  examined: number;
  alerted: number;
  failed: number;
}

export async function alertStuckGatewayPayments(deps: StuckPaymentDeps): Promise<StuckPaymentResult> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - deps.config.olderThanHours * 3_600_000);
  const stuck = await deps.store.findStuckGatewayPayments(cutoff, deps.config.batchSize);

  let alerted = 0;
  let failed = 0;

  for (const payment of stuck) {
    try {
      const gatewayLabel = GATEWAY_LABEL[payment.gateway] ?? payment.gateway;
      await deps.alerter.send(
        'warn',
        `Pago ${payment.method.toUpperCase()} pendiente hace más de ${deps.config.olderThanHours}h — revisar con soporte de ${gatewayLabel}`,
        {
          order: payment.orderNumber,
          gateway: payment.gateway,
          method: payment.method,
          amountMxn: (payment.amountExpectedCents / 100).toFixed(2),
          pendingHours: payment.pendingHours,
        },
      );
      // Marked AFTER a successful send: a failed alert must retry next sweep
      // rather than being silently marked done and never mentioned again.
      await deps.store.markStuckAlertSent(payment.paymentId);
      alerted++;
    } catch (err) {
      failed++;
      console.error(`[stuck-payments] Could not alert on ${payment.orderNumber}: ${String(err)}`);
    }
  }

  return { examined: stuck.length, alerted, failed };
}
