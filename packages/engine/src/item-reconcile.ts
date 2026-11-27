/**
 * Proactively re-check RocketPass item orders nobody's webhook ever settled —
 * the item-order equivalent of `gateway-reconcile.ts`, built 2026-11-27 after
 * Jose reported orders RocketPass's own panel already shows `DELIVERED`
 * sitting stuck at "en proceso" in this dashboard forever. `fulfillItemOrder`
 * records `rocketpassOrderId` the moment RocketPass accepts an order, then
 * leaves everything else to `applyRocketPassWebhookOrder` — if that webhook
 * is ever missed or misfires (the exact failure mode already confirmed for
 * Stripe/Mercado Pago's own webhooks this same week), nothing else was ever
 * asking RocketPass directly, so the order just sits there with no self-heal.
 *
 * Deliberately thin, same discipline as `reconcilePendingGatewayPayments`:
 * this never decides what a RocketPass order outcome means, it only asks
 * RocketPass and feeds the answer through the exact same
 * `decideItemFulfillment`/`applyDecision` the webhook already goes through.
 */

import { decideItemFulfillment, type ItemFulfillmentDecision } from './item-fulfillment.js';
import type { RocketPassOrderStatus } from '@levelup/rocketpass';
import type { Alerter } from './ports.js';

export interface PendingItemOrder {
  orderId: string;
  orderNumber: string;
  rocketpassOrderId: string;
  attemptCount: number;
}

export interface ItemReconcileStore {
  listPendingItemOrders(input: { olderThanMs: number; limit: number }): Promise<PendingItemOrder[]>;
  applyDecision(orderId: string, decision: ItemFulfillmentDecision): Promise<void>;
}

/** The one thing asked of RocketPass — matches `RocketPassClient.getOrder` structurally, without this package depending on it. */
export interface ItemOrderStatusCheck {
  getOrder(rocketpassOrderId: string): Promise<{ status: RocketPassOrderStatus } | null>;
}

const NOT_FINAL: ReadonlySet<RocketPassOrderStatus> = new Set(['PENDING', 'PROCESSING']);

export interface ItemReconcileDeps {
  store: ItemReconcileStore;
  client: ItemOrderStatusCheck;
  alerter: Alerter;
  config: { maxAttempts: number };
}

export interface ItemReconcileOptions {
  olderThanMs: number;
  limit: number;
}

export interface ItemReconcileResult {
  examined: number;
  /** Resolved one way or another — delivered, partial, failed, or cancelled. */
  settled: number;
  stillPending: number;
  /** Checking or settling that one order threw — logged by the caller, not retried within this pass. */
  errored: number;
}

export async function reconcilePendingItemOrders(
  deps: ItemReconcileDeps,
  options: ItemReconcileOptions,
): Promise<ItemReconcileResult> {
  const pending = await deps.store.listPendingItemOrders({
    olderThanMs: options.olderThanMs,
    limit: options.limit,
  });

  const result: ItemReconcileResult = { examined: pending.length, settled: 0, stillPending: 0, errored: 0 };

  for (const order of pending) {
    try {
      const snapshot = await deps.client.getOrder(order.rocketpassOrderId);
      if (!snapshot || NOT_FINAL.has(snapshot.status)) {
        result.stillPending++;
        continue;
      }

      const decision = decideItemFulfillment(
        { ok: true, rocketpassOrderId: order.rocketpassOrderId, status: snapshot.status },
        order.attemptCount,
        deps.config.maxAttempts,
      );
      await deps.store.applyDecision(order.orderId, decision);

      if (decision.alert) {
        await deps.alerter.send(decision.alert.level, decision.alert.title, {
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          ...decision.alert.detail,
        });
      }
      result.settled++;
    } catch {
      // One order's own error (a transient RocketPass timeout, say) must not
      // stop the rest of the batch — same reasoning as every other sweep
      // step in this codebase. Nothing here decides this order's fate on a
      // failed check, so it's simply tried again next sweep.
      result.errored++;
    }
  }

  return result;
}
