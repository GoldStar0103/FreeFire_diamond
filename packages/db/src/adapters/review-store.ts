/**
 * Drizzle implementation of the engine's `ReviewStore` port.
 *
 * `applyReview` is compare-and-set all the way down: the order and every item
 * are updated only while still in the status the plan was computed against,
 * inside one transaction with the audit row. If any guard matches nothing, the
 * whole thing rolls back and the admin is told the order moved under them —
 * never a half-applied decision about money.
 */

import { and, eq } from 'drizzle-orm';
import { ReviewConflictError, type ReviewOrder, type ReviewPlan, type ReviewStore } from '@levelup/engine';
import type { Database } from '../index.js';
import { auditLog, orderItems, orders } from '../schema.js';

export class DrizzleReviewStore implements ReviewStore {
  constructor(private readonly db: Database) {}

  async loadForReview(orderId: string): Promise<ReviewOrder | null> {
    const [order] = await this.db
      .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order) return null;

    const items = await this.db
      .select({
        id: orderItems.id,
        sequence: orderItems.sequence,
        status: orderItems.status,
        attemptCount: orderItems.attemptCount,
        diamondsBase: orderItems.diamondsBase,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    return { ...order, items: items.sort((a, b) => a.sequence - b.sequence) };
  }

  async applyReview(plan: ReviewPlan, adminUserId: string): Promise<void> {
    const now = new Date();

    await this.db.transaction(async (tx) => {
      const moved = await tx
        .update(orders)
        .set({
          status: plan.nextOrderStatus,
          updatedAt: now,
          ...(plan.nextOrderStatus === 'completed' ? { completedAt: now } : {}),
        })
        .where(and(eq(orders.id, plan.orderId), eq(orders.status, plan.expectedOrderStatus)))
        .returning({ id: orders.id });

      if (moved.length === 0) {
        throw new ReviewConflictError(
          `${plan.orderNumber} changed while you were reviewing it. Reload and check again.`,
        );
      }

      for (const update of plan.itemUpdates) {
        const set =
          update.status === 'succeeded'
            ? { status: 'succeeded' as const, resolvedBy: 'manual' as const, settledAt: now }
            : {
                status: 'queued' as const,
                resolvedBy: 'manual' as const,
                ...(update.resetAttempts ? { attemptCount: 0 } : {}),
              };

        const changed = await tx
          .update(orderItems)
          .set(set)
          .where(
            and(
              eq(orderItems.id, update.itemId),
              eq(orderItems.orderId, plan.orderId),
              eq(orderItems.status, update.expectedStatus),
            ),
          )
          .returning({ id: orderItems.id });

        if (changed.length === 0) {
          throw new ReviewConflictError(
            `A recharge on ${plan.orderNumber} changed while you were reviewing it. Reload and check again.`,
          );
        }
      }

      await tx.insert(auditLog).values({
        adminUserId,
        action: plan.audit.action,
        entityType: 'order',
        entityId: plan.orderId,
        detail: {
          ...plan.audit.detail,
          from: plan.expectedOrderStatus,
          to: plan.nextOrderStatus,
        },
      });
    });
  }
}
