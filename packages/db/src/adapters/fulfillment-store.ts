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
import { orderItems, orders } from '../schema.js';
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
        providerProductId: orderItems.providerProductId,
        diamondsBase: orderItems.diamondsBase,
        costUsd: orderItems.costUsd,
        status: orderItems.status,
        attemptCount: orderItems.attemptCount,
        providerReference: orderItems.providerReference,
        walletBeforeUsd: orderItems.walletBeforeUsd,
      })
      .from(orderItems)
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
    await this.db
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
      .where(eq(orderItems.id, itemId));
  }

  async updateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    await this.db
      .update(orders)
      .set({
        status,
        updatedAt: new Date(),
        // Stamped once, when the order actually finishes — this is the number
        // the "entrega en 1-10 minutos" promise gets measured against.
        ...(status === 'completed' ? { completedAt: new Date() } : {}),
      })
      .where(eq(orders.id, orderId));
  }
}
