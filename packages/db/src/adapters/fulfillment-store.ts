/**
 * Drizzle implementation of the engine's `FulfillmentStore` port.
 *
 * The engine is deliberately ignorant of Postgres; this is the only place the
 * two meet. Every method here has to preserve one property the engine relies
 * on: `markItemSending` must be durably committed before the provider call
 * leaves the process, because that row is the sole evidence a call was ever
 * attempted if the worker dies mid-flight.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { UsdTenK } from '@levelup/provider';
import type {
  FulfillmentStore,
  ItemSettlement,
  OrderRecord,
  OrderStatus,
} from '@levelup/engine';
import type { Database } from '../index.js';
import { baseProducts, notifications, orderItems, orders } from '../schema.js';
import { toNumericString, toOrderRecord } from './mapping.js';

/** States an item may legitimately be dispatched from. */
const DISPATCHABLE = ['queued', 'failed'] as const;

export class DrizzleFulfillmentStore implements FulfillmentStore {
  constructor(private readonly db: Database) {}

  async loadOrder(orderId: string): Promise<OrderRecord | null> {
    const [order] = await this.db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        playerId: orders.playerId,
        serverId: orders.serverId,
        status: orders.status,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) return null;

    const items = await this.db
      .select({
        id: orderItems.id,
        sequence: orderItems.sequence,
        provider: orderItems.provider,
        providerProductId: orderItems.providerProductId,
        diamondsBase: orderItems.diamondsBase,
        costUsd: orderItems.costUsd,
        status: orderItems.status,
        attemptCount: orderItems.attemptCount,
        providerReference: orderItems.providerReference,
        walletBeforeUsd: orderItems.walletBeforeUsd,
        // Left join: an item must stay loadable even if its product row is
        // ever gone, and the engine falls back to the verified endpoint.
        endpointKind: baseProducts.endpointKind,
        // Null on a missing row is treated as active by the engine — the
        // withdrawal it must act on is the product row saying so explicitly.
        productActive: baseProducts.active,
      })
      .from(orderItems)
      .leftJoin(baseProducts, eq(baseProducts.id, orderItems.baseProductId))
      .where(eq(orderItems.orderId, orderId));

    return toOrderRecord(order, items);
  }

  async markItemSending(itemId: string, walletBeforeUsd: UsdTenK): Promise<void> {
    // Guarded by state, not just by the advisory lock. Two workers racing to
    // dispatch the same item would otherwise both succeed and double-deliver;
    // here the second update matches zero rows and throws.
    const updated = await this.db
      .update(orderItems)
      .set({
        status: 'sending',
        attemptCount: sql`${orderItems.attemptCount} + 1`,
        walletBeforeUsd: toNumericString(walletBeforeUsd),
        sentAt: new Date(),
      })
      .where(and(eq(orderItems.id, itemId), inArray(orderItems.status, [...DISPATCHABLE])))
      .returning({ id: orderItems.id });

    if (updated.length === 0) {
      throw new Error(
        `Refusing to dispatch item ${itemId}: it is not in a dispatchable state ` +
          `(${DISPATCHABLE.join(' or ')}). Another worker may already have it.`,
      );
    }
  }

  async settleItem(itemId: string, settlement: ItemSettlement): Promise<void> {
    // Guarded the same way `markItemSending` is: an item only ever reaches
    // here from `sending` (the live dispatch, or `recoverStalledItems` finding
    // it abandoned) or `provider_pending` (`pollPendingOrders` resolving a
    // PENDING reference). A live call that stalls past `minAgeMs` and *then*
    // finally answers would otherwise race the poller that reconciled it in
    // the meantime, each settlement silently overwriting the other's verdict.
    const updated = await this.db
      .update(orderItems)
      .set({
        status: settlement.status,
        settledAt: new Date(),
        ...(settlement.providerTransactionId !== undefined && {
          providerTransactionId: settlement.providerTransactionId,
        }),
        ...(settlement.providerReference !== undefined && {
          providerReference: settlement.providerReference,
        }),
        ...(settlement.walletAfterUsd != null && {
          walletAfterUsd: toNumericString(settlement.walletAfterUsd),
        }),
        ...(settlement.resolvedBy !== undefined && { resolvedBy: settlement.resolvedBy }),
        ...(settlement.errorCode !== undefined && { errorCode: settlement.errorCode }),
        ...(settlement.responsePayload !== undefined && {
          responsePayload: settlement.responsePayload,
        }),
      })
      .where(and(eq(orderItems.id, itemId), inArray(orderItems.status, ['sending', 'provider_pending'])))
      .returning({ id: orderItems.id });

    if (updated.length === 0) {
      throw new Error(
        `Item ${itemId} was already settled before this write landed — refusing to overwrite it.`,
      );
    }
  }

  async updateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    const [order] = await this.db
      .update(orders)
      .set({
        status,
        updatedAt: new Date(),
        // Stamped once, when the order actually finishes — this is the number
        // the "entrega en 1-10 minutos" promise gets measured against.
        ...(status === 'completed' ? { completedAt: new Date() } : {}),
      })
      .where(eq(orders.id, orderId))
      .returning({ orderNumber: orders.orderNumber, playerId: orders.playerId, playerProfileId: orders.playerProfileId });

    // A fresh arrival at `needs_review` — automatic (insufficient balance,
    // exhausted retries) or emergency mode's manual hold — is the one point
    // this status is reachable from that the customer hasn't already been
    // told about some other way. Worded the same calm way the tracker page
    // itself does ("con_problema"/`STATUS.con_problema` in `pedido/[orderNumber]`):
    // a human is already on it, not an alarm. `onConflictDoNothing` is the
    // idempotency guard — `updateOrderStatus` has no compare-and-set of its
    // own, so two racing fulfilment runs could otherwise both land here.
    if (status === 'needs_review' && order?.playerProfileId) {
      await this.db
        .insert(notifications)
        .values({
          playerProfileId: order.playerProfileId,
          type: 'order_failed',
          title: 'Estamos revisando tu pedido',
          message: `Tu pedido ${order.orderNumber} necesita que lo revisemos a mano. Ya lo estamos atendiendo.`,
          targetUrl: `/pedido/${order.orderNumber}?id=${encodeURIComponent(order.playerId)}`,
          orderId,
        })
        .onConflictDoNothing({ target: [notifications.orderId, notifications.type] });
    }
  }
}
