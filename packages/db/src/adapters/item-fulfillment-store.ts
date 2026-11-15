/**
 * Drizzle implementation of the engine's `ItemFulfillmentStore` port, plus
 * the item-order equivalent of `DrizzleOrderQueue.claimNext`.
 *
 * Kept standalone rather than extending `DrizzleFulfillmentStore` — nothing
 * here needs `loadOrder`/`markItemSending`/`settleItem`, which are shaped
 * around the diamond recipe (`order_items`) an item order never has any of.
 */

import { eq, sql } from 'drizzle-orm';
import type {
  ItemFulfillmentDecision,
  ItemFulfillmentStore,
  ItemOrderRecord,
  ItemWebhookStore,
} from '@levelup/engine';
import type { CreateOrderInput } from '@levelup/rocketpass';
import type { Database } from '../index.js';
import { itemOrderDetails, notifications, orders } from '../schema.js';

export interface ClaimedItemOrder {
  id: string;
  orderNumber: string;
  recovered: boolean;
}

export class DrizzleItemOrderQueue {
  constructor(private readonly db: Database) {}

  /**
   * Same shape as `DrizzleOrderQueue.claimNext`: one atomic statement,
   * `FOR UPDATE SKIP LOCKED` so two workers never take the same row.
   *
   * `awaiting_stock` is claimable right alongside `pending` — reusing this
   * same claim is what retries a stock-out automatically on the next sweep,
   * with no separate recovery job needed. The stale-`processing` recovery
   * branch only ever matches a row with no `rocketpass_order_id` yet: once
   * RocketPass has confirmed an id, only the poller/webhook may touch it —
   * re-claiming it here would risk a second `POST /orders` for an order that
   * may already be settling.
   */
  async claimNext(staleAfterMs: number): Promise<ClaimedItemOrder | null> {
    const staleSeconds = staleAfterMs / 1000;

    const rows = await this.db.execute<{ id: string; order_number: string; prev_status: string }>(sql`
      WITH candidate AS (
        SELECT o.id, o.status AS prev_status
          FROM orders o
          JOIN item_order_details iod ON iod.order_id = o.id
         WHERE o.order_type = 'item'
           AND (
                (o.status IN ('payment_confirmed', 'partially_delivered')
                 AND iod.fulfillment_status IN ('pending', 'awaiting_stock'))
             OR (o.status = 'processing'
                 AND iod.fulfillment_status = 'processing'
                 AND iod.rocketpass_order_id IS NULL
                 AND o.updated_at < now() - make_interval(secs => ${staleSeconds}))
           )
         ORDER BY o.created_at ASC
         LIMIT 1
           FOR UPDATE SKIP LOCKED
      )
      UPDATE orders o
         SET status = 'processing', updated_at = now()
        FROM candidate c
       WHERE o.id = c.id
   RETURNING o.id, o.order_number, c.prev_status
    `);

    const row = rows[0];
    if (!row) return null;
    return { id: row.id, orderNumber: row.order_number, recovered: row.prev_status === 'processing' };
  }
}

export class DrizzleItemFulfillmentStore implements ItemFulfillmentStore, ItemWebhookStore {
  constructor(private readonly db: Database) {}

  async loadItemOrder(orderId: string): Promise<ItemOrderRecord | null> {
    const [row] = await this.db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        playerId: orders.playerId,
        sku: itemOrderDetails.itemSku,
        itemName: itemOrderDetails.itemNameSnapshot,
        quantity: itemOrderDetails.quantity,
        region: itemOrderDetails.region,
        fulfillmentStatus: itemOrderDetails.fulfillmentStatus,
        rocketpassOrderId: itemOrderDetails.rocketpassOrderId,
        attemptCount: itemOrderDetails.attemptCount,
      })
      .from(orders)
      .innerJoin(itemOrderDetails, eq(itemOrderDetails.orderId, orders.id))
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!row) return null;
    return {
      ...row,
      sku: row.sku as CreateOrderInput['item'],
      region: row.region as CreateOrderInput['region'] | null,
    };
  }

  /** For the RocketPass webhook — settling an order it placed earlier. */
  async findItemOrderByRocketpassId(
    rocketpassOrderId: string,
  ): Promise<{ orderId: string; attemptCount: number } | null> {
    const [row] = await this.db
      .select({ orderId: itemOrderDetails.orderId, attemptCount: itemOrderDetails.attemptCount })
      .from(itemOrderDetails)
      .where(eq(itemOrderDetails.rocketpassOrderId, rocketpassOrderId))
      .limit(1);
    return row ?? null;
  }

  /** CAS-free by design: this is the worker's own loop claiming its own row via `DrizzleItemOrderQueue`. */
  async markSending(orderId: string): Promise<void> {
    const updated = await this.db
      .update(itemOrderDetails)
      .set({
        fulfillmentStatus: 'processing',
        attemptCount: sql`${itemOrderDetails.attemptCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(itemOrderDetails.orderId, orderId))
      .returning({ id: itemOrderDetails.id });

    if (updated.length === 0) {
      throw new Error(`No item_order_details row for order ${orderId}`);
    }
  }

  async applyDecision(orderId: string, decision: ItemFulfillmentDecision): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(itemOrderDetails)
        .set({
          fulfillmentStatus: decision.itemStatus,
          ...(decision.rocketpassOrderId ? { rocketpassOrderId: decision.rocketpassOrderId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(itemOrderDetails.orderId, orderId));

      if (!decision.orderStatus) return;

      const now = new Date();
      const [order] = await tx
        .update(orders)
        .set({
          status: decision.orderStatus,
          updatedAt: now,
          ...(decision.orderStatus === 'completed' ? { completedAt: now } : {}),
        })
        .where(eq(orders.id, orderId))
        .returning({ orderNumber: orders.orderNumber, playerId: orders.playerId, playerProfileId: orders.playerProfileId });

      // Only accounts have a bell to ring — a guest checkout has no bell,
      // same gate every other notification in this codebase uses.
      if (!order?.playerProfileId) return;

      if (decision.orderStatus === 'completed') {
        await tx
          .insert(notifications)
          .values({
            playerProfileId: order.playerProfileId,
            type: 'order_delivered',
            title: '¡Tu artículo ya llegó!',
            message: `Tu pedido ${order.orderNumber} fue entregado.`,
            targetUrl: `/pedido/${order.orderNumber}?id=${encodeURIComponent(order.playerId)}`,
            orderId,
          })
          .onConflictDoNothing({ target: [notifications.orderId, notifications.type] });
      } else if (decision.orderStatus === 'needs_review') {
        await tx
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
    });
  }
}
