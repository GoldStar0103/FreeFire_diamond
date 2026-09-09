/**
 * Retiring orders that were never paid.
 *
 * Without this, `pending_payment` is a terminal state in practice: nothing ever
 * moves an unpaid order anywhere else. That matters more than it sounds,
 * because the Mega Oferta's one-per-player rule counts pending orders — so one
 * abandoned attempt permanently consumes a customer's entry offer, and the
 * store tells them they already used an offer they never received.
 *
 * The rule this must never break: only a payment still sitting at `pending` is
 * eligible. Once a comprobante is uploaded the payment moves to `under_review`,
 * which means a real person has already sent real money and is waiting on the
 * panel. Expiring one of those would cancel a paid order, which is far worse
 * than the problem being solved.
 */

export interface OverduePayment {
  orderId: string;
  paymentId: string;
  orderNumber: string;
}

export interface ExpiryStore {
  /**
   * Payments still `pending` whose deadline has passed, whose order is still
   * `pending_payment`. The filtering belongs in the query so a caller cannot
   * accidentally widen it.
   */
  findOverduePayments(now: Date, limit: number): Promise<OverduePayment[]>;
  expirePayment(input: { orderId: string; paymentId: string }): Promise<void>;
}

export interface ExpiryDeps {
  store: ExpiryStore;
  config: { batchSize: number };
  now?: () => Date;
}

export interface ExpiryResult {
  examined: number;
  expired: number;
  failed: number;
}

export async function expireOverduePayments(deps: ExpiryDeps): Promise<ExpiryResult> {
  const now = (deps.now ?? (() => new Date()))();
  const overdue = await deps.store.findOverduePayments(now, deps.config.batchSize);

  let expired = 0;
  let failed = 0;

  for (const payment of overdue) {
    try {
      await deps.store.expirePayment({
        orderId: payment.orderId,
        paymentId: payment.paymentId,
      });
      expired++;
    } catch (err) {
      // One bad row must not stop the rest. A blocked Mega Oferta slot stays
      // blocked until this succeeds, so the next sweep should get another go.
      failed++;
      console.error(`[expiry] Could not expire ${payment.orderNumber}: ${String(err)}`);
    }
  }

  return { examined: overdue.length, expired, failed };
}
