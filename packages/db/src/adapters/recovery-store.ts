/**
 * Drizzle implementation of the engine's `RecoveryStore` port.
 *
 * Two queries feeding the crons that close the gaps a fulfilment run cannot:
 *
 *   - items the provider left PENDING, which only resolve by polling
 *   - items stuck in `sending`, meaning a worker died mid-call
 *
 * Both are age-gated. Without that, the sweeps would pick up work the live run
 * is still doing and race it — the age window is what makes "nobody is
 * currently handling this" a safe inference.
 */

import { and, asc, eq, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import { parseUsd } from '@levelup/provider';
import type { ExpiryStore, OverduePayment, RecoveryStore, StalledItem } from '@levelup/engine';
import type { Database } from '../index.js';
import { orderItems, orders, payments } from '../schema.js';
import { DrizzleFulfillmentStore } from './fulfillment-store.js';

/** Orders nobody should be spending money on, whatever their items say. */
const ABANDONED = ['cancelled', 'payment_expired', 'refund_required'] as const;

interface SweepRow {
  itemId: string;
  orderId: string;
  orderNumber: string;
  providerReference: string | null;
  costUsd: string | null;
  walletBeforeUsd: string | null;
  attemptCount: number;
  ageMs: string | number;
}

function toStalledItem(row: SweepRow): StalledItem {
  return {
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    itemId: row.itemId,
    providerReference: row.providerReference,
    // Guaranteed non-null by the query — see the note on each `where` clause.
    costUsd: parseUsd(row.costUsd!),
    walletBeforeUsd: row.walletBeforeUsd === null ? null : parseUsd(row.walletBeforeUsd),
    attemptCount: row.attemptCount,
    ageMs: Math.round(Number(row.ageMs)),
  };
}

export class DrizzleRecoveryStore
  extends DrizzleFulfillmentStore
  implements RecoveryStore, ExpiryStore
{
  constructor(private readonly database: Database) {
    super(database);
  }

  /**
   * Items the provider accepted but has not finished.
   *
   * Age is measured from `settled_at` — the moment we recorded PENDING — so a
   * call made seconds ago is left alone to resolve on its own.
   */
  async findPendingProviderItems(olderThanMs: number, limit: number): Promise<StalledItem[]> {
    const rows = await this.database
      .select({
        itemId: orderItems.id,
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        providerReference: orderItems.providerReference,
        costUsd: orderItems.costUsd,
        walletBeforeUsd: orderItems.walletBeforeUsd,
        attemptCount: orderItems.attemptCount,
        ageMs: sql<string>`EXTRACT(EPOCH FROM (now() - ${orderItems.settledAt})) * 1000`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orderItems.status, 'provider_pending'),
          // Without a cost there is nothing to reconcile against; `loadOrder`
          // raises that as an un-synced catalog rather than a provider fault.
          isNotNull(orderItems.costUsd),
          isNotNull(orderItems.settledAt),
          sql`${orderItems.settledAt} < now() - make_interval(secs => ${olderThanMs / 1000})`,
          notInArray(orders.status, [...ABANDONED]),
        ),
      )
      // Oldest first: the ones closest to escalation matter most.
      .orderBy(asc(orderItems.settledAt))
      .limit(limit);

    return rows.map(toStalledItem);
  }

  /**
   * Items left mid-flight by a dead worker.
   *
   * The `sending` row was committed before the HTTP request went out precisely
   * so this query can find it. Age is measured from `sent_at`.
   */
  async findStalledSendingItems(olderThanMs: number, limit: number): Promise<StalledItem[]> {
    const rows = await this.database
      .select({
        itemId: orderItems.id,
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        providerReference: orderItems.providerReference,
        costUsd: orderItems.costUsd,
        walletBeforeUsd: orderItems.walletBeforeUsd,
        attemptCount: orderItems.attemptCount,
        ageMs: sql<string>`EXTRACT(EPOCH FROM (now() - ${orderItems.sentAt})) * 1000`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orderItems.status, 'sending'),
          isNotNull(orderItems.costUsd),
          isNotNull(orderItems.sentAt),
          sql`${orderItems.sentAt} < now() - make_interval(secs => ${olderThanMs / 1000})`,
          notInArray(orders.status, [...ABANDONED]),
        ),
      )
      .orderBy(asc(orderItems.sentAt))
      .limit(limit);

    return rows.map(toStalledItem);
  }

  /**
   * Unpaid orders past their deadline.
   *
   * Three conditions, and every one of them is load-bearing:
   *
   *   - `payments.status = 'pending'` — the moment a comprobante is uploaded
   *     this becomes `under_review`, which means somebody has already sent real
   *     money. Expiring one of those would cancel a paid order.
   *   - `orders.status = 'pending_payment'` — belt and braces on the same idea.
   *   - a deadline that has actually passed. Rows written before payments had
   *     deadlines have a null `expires_at` and are left alone rather than
   *     treated as infinitely overdue.
   */
  async findOverduePayments(now: Date, limit: number): Promise<OverduePayment[]> {
    return this.database
      .select({
        orderId: orders.id,
        paymentId: payments.id,
        orderNumber: orders.orderNumber,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(
        and(
          eq(payments.status, 'pending'),
          eq(orders.status, 'pending_payment'),
          isNotNull(payments.expiresAt),
          lt(payments.expiresAt, now),
        ),
      )
      .orderBy(asc(payments.expiresAt))
      .limit(limit);
  }

  /** Mirrors `DrizzlePaymentStore.expirePayment`; the sweep needs it here. */
  async expirePayment(input: { orderId: string; paymentId: string }): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.update(payments).set({ status: 'expired' }).where(eq(payments.id, input.paymentId));
      await tx
        .update(orders)
        .set({ status: 'payment_expired', updatedAt: new Date() })
        .where(eq(orders.id, input.orderId));
    });
  }
}
