/**
 * Drizzle implementation of the engine's `ExpiryReminderStore` port.
 *
 * Mirrors `DrizzleRecoveryStore.findOverduePayments` — same shape of query,
 * one window earlier. The "already reminded" check is a left join against
 * `notifications` rather than a column on `payments`, since the
 * `(order_id, type)` unique index already backing every other notification
 * type is the idempotency guard this needs too, and adding it here avoids a
 * second mechanism for the same thing.
 */

import { and, asc, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import type { ExpiringPayment, ExpiryReminderStore } from '@levelup/engine';
import type { Database } from '../index.js';
import { notifications, orders, payments } from '../schema.js';

export class DrizzleExpiryReminderStore implements ExpiryReminderStore {
  constructor(private readonly db: Database) {}

  async findExpiringPayments(now: Date, windowMs: number, limit: number): Promise<ExpiringPayment[]> {
    const windowEnd = new Date(now.getTime() + windowMs);
    return this.db
      .select({ orderId: orders.id, orderNumber: orders.orderNumber })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .leftJoin(
        notifications,
        and(eq(notifications.orderId, orders.id), eq(notifications.type, 'order_expiring')),
      )
      .where(
        and(
          eq(payments.status, 'pending'),
          eq(orders.status, 'pending_payment'),
          // No account, no bell — same gate every other notification uses.
          isNotNull(orders.playerProfileId),
          isNotNull(payments.expiresAt),
          gt(payments.expiresAt, now),
          lte(payments.expiresAt, windowEnd),
          isNull(notifications.id),
        ),
      )
      .orderBy(asc(payments.expiresAt))
      .limit(limit);
  }

  async sendReminder(orderId: string): Promise<void> {
    const [order] = await this.db
      .select({
        orderNumber: orders.orderNumber,
        playerId: orders.playerId,
        playerProfileId: orders.playerProfileId,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order?.playerProfileId) return;

    await this.db
      .insert(notifications)
      .values({
        playerProfileId: order.playerProfileId,
        type: 'order_expiring',
        title: 'Tu pedido está por vencer',
        message: `Completa el pago de ${order.orderNumber} antes de que se venza el tiempo.`,
        targetUrl: `/pedido/${order.orderNumber}?id=${encodeURIComponent(order.playerId)}`,
        orderId,
      })
      .onConflictDoNothing({ target: [notifications.orderId, notifications.type] });
  }
}
