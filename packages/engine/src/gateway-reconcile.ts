/**
 * Proactively re-check pending gateway payments that nobody's webhook ever
 * settled — built 2026-11-26 after a real production incident: Mercado
 * Pago's Checkout Pro webhook was not reaching the web app at all (zero
 * deliveries logged), and the order-tracking page's own "ask the gateway
 * directly" safety net (apps/web's `reconcileCard`) only runs when a
 * customer actually reloads that page. A customer who paid, closed the tab,
 * and never came back had no path left to ever get their diamonds — this
 * sweep is that path, run on a schedule instead of on a page load.
 *
 * Deliberately thin, same discipline as `settleGatewayCharge`'s own doc
 * comment: this never decides what a payment means, it only asks the
 * gateway and feeds the answer through the exact same `settleGatewayCharge`
 * a webhook or a human's "aprobar" tap already goes through.
 */

import { settleGatewayCharge, type PaymentDeps, type GatewayChargeState } from './payments.js';

export interface PendingGatewayPayment {
  paymentId: string;
  orderId: string;
  orderNumber: string;
  gatewayChargeId: string;
}

export interface GatewayReconcileStore {
  listPendingGatewayPayments(input: {
    gateway: string;
    olderThanMs: number;
    limit: number;
  }): Promise<PendingGatewayPayment[]>;
}

/** The one thing asked of the gateway — matches `PaymentGateway['getCharge']` in @levelup/payments structurally, without this package depending on it. */
export interface GatewayChargeCheck {
  getCharge(gatewayChargeId: string): Promise<{
    state: GatewayChargeState;
    amountReceivedCents: number | null;
    reference?: string | null;
  } | null>;
}

export interface GatewayReconcileDeps extends PaymentDeps {
  store: PaymentDeps['store'] & GatewayReconcileStore;
  gateway: GatewayChargeCheck;
}

export interface GatewayReconcileOptions {
  gatewayName: string;
  olderThanMs: number;
  limit: number;
}

export interface GatewayReconcileResult {
  examined: number;
  /** Resolved one way or another — paid, failed, or expired. */
  settled: number;
  stillPending: number;
  /** Checking or settling that one payment threw — logged by the caller, not retried within this pass. */
  errored: number;
}

export async function reconcilePendingGatewayPayments(
  deps: GatewayReconcileDeps,
  options: GatewayReconcileOptions,
): Promise<GatewayReconcileResult> {
  const pending = await deps.store.listPendingGatewayPayments({
    gateway: options.gatewayName,
    olderThanMs: options.olderThanMs,
    limit: options.limit,
  });

  const result: GatewayReconcileResult = { examined: pending.length, settled: 0, stillPending: 0, errored: 0 };

  for (const payment of pending) {
    try {
      const snapshot = await deps.gateway.getCharge(payment.gatewayChargeId);
      if (!snapshot || snapshot.state === 'pending') {
        result.stillPending++;
        continue;
      }

      await settleGatewayCharge(deps, {
        orderId: payment.orderId,
        state: snapshot.state,
        amountReceivedCents: snapshot.amountReceivedCents,
        reference: snapshot.reference ?? null,
      });
      result.settled++;
    } catch {
      // One payment's own error (a transient gateway timeout, say) must not
      // stop the rest of the batch — same reasoning as every other sweep
      // step in this codebase. The caller logs it; nothing here decides
      // this payment's fate on a failed check, so it's simply tried again
      // next sweep.
      result.errored++;
    }
  }

  return result;
}
