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

import { and, asc, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import { parseUsd } from '@levelup/provider';
import type { RecoveryStore, StalledItem } from '@levelup/engine';
import type { Database } from '../index.js';
import { orderItems, orders } from '../schema.js';
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

export class DrizzleRecoveryStore extends DrizzleFulfillmentStore implements RecoveryStore {
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
}
