/**
 * Row -> domain mapping.
 *
 * Kept pure and separate from the query so it can be tested without a database.
 * The fiddly part is money: postgres.js returns `numeric` as a string precisely
 * to avoid float precision loss, so every cost crosses this boundary as text and
 * is parsed deliberately rather than coerced.
 */

import { parseUsd, type UsdTenK } from '@levelup/provider';
import type { OrderItemRecord, OrderRecord } from '@levelup/engine';
import type { OrderItemStatus, OrderStatus } from '@levelup/engine';

export interface OrderRow {
  id: string;
  orderNumber: string;
  playerId: string;
  serverId: string | null;
  status: OrderStatus;
}

export interface OrderItemRow {
  id: string;
  sequence: number;
  providerProductId: string;
  diamondsBase: number;
  costUsd: string | null;
  status: OrderItemStatus;
  attemptCount: number;
  providerReference: string | null;
  walletBeforeUsd: string | null;
}

export function toOrderItemRecord(row: OrderItemRow): OrderItemRecord {
  if (row.costUsd === null) {
    // Cost comes from the synced provider catalog. Without it the wallet-delta
    // check has nothing to compare against, so this must fail loudly rather
    // than default to zero and quietly make every ambiguity indeterminate.
    throw new Error(
      `Order item ${row.id} has no cost_usd — run the provider catalog sync before fulfilling.`,
    );
  }

  return {
    id: row.id,
    sequence: row.sequence,
    providerProductId: row.providerProductId,
    diamondsBase: row.diamondsBase,
    costUsd: parseUsd(row.costUsd),
    status: row.status,
    attemptCount: row.attemptCount,
    providerReference: row.providerReference,
    walletBeforeUsd: row.walletBeforeUsd === null ? null : parseUsd(row.walletBeforeUsd),
  };
}

export function toOrderRecord(order: OrderRow, items: OrderItemRow[]): OrderRecord {
  if (items.length === 0) {
    throw new Error(`Order ${order.orderNumber} has no items — it cannot be fulfilled.`);
  }

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    playerId: order.playerId,
    serverId: order.serverId,
    status: order.status,
    // Sequence is the order the client's recipe defines, not insertion order.
    items: items.sort((a, b) => a.sequence - b.sequence).map(toOrderItemRecord),
  };
}

/** UsdTenK -> the `numeric(12,4)` string Postgres expects. */
export const toNumericString = (value: UsdTenK): string => (value / 10_000).toFixed(4);
