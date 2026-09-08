/**
 * Ports the fulfilment engine depends on.
 *
 * The engine is the crown jewel of this project, so it is deliberately kept
 * free of Drizzle, Postgres and HTTP. It talks to these interfaces, which means
 * the entire failure matrix runs in milliseconds with no database — and the
 * logic under test is the same logic that runs in production.
 */

import type { UsdTenK } from '@levelup/provider';
import type { OrderItemStatus, OrderStatus } from './states.js';

export interface OrderItemRecord {
  id: string;
  sequence: number;
  providerProductId: string;
  diamondsBase: number;
  costUsd: UsdTenK;
  status: OrderItemStatus;
  attemptCount: number;
  providerReference: string | null;
  walletBeforeUsd: UsdTenK | null;
}

export interface OrderRecord {
  id: string;
  orderNumber: string;
  playerId: string;
  serverId: string | null;
  status: OrderStatus;
  /** Every item is one provider call. Mega Prime 48k has eight. */
  items: OrderItemRecord[];
}

export interface ItemSettlement {
  status: OrderItemStatus;
  providerTransactionId?: string | null;
  providerReference?: string | null;
  walletAfterUsd?: UsdTenK | null;
  resolvedBy?: 'response' | 'wallet_delta' | 'polling' | 'manual';
  errorCode?: string | null;
  responsePayload?: unknown;
}

export interface FulfillmentStore {
  loadOrder(orderId: string): Promise<OrderRecord | null>;

  /**
   * Record intent BEFORE the HTTP call and commit it.
   *
   * If the process dies mid-call, recovery finds an item stuck in `sending`
   * with a `walletBeforeUsd` to reconcile against. Without this write there is
   * no evidence the call was ever attempted.
   */
  markItemSending(itemId: string, walletBeforeUsd: UsdTenK): Promise<void>;

  settleItem(itemId: string, settlement: ItemSettlement): Promise<void>;
  updateOrderStatus(orderId: string, status: OrderStatus): Promise<void>;
}

export type AlertLevel = 'info' | 'warn' | 'critical';

export interface Alerter {
  /** Reaches a human — Telegram in production. */
  send(level: AlertLevel, title: string, detail?: Record<string, unknown>): Promise<void>;
}

/**
 * Serialises provider calls across processes.
 *
 * Wallet-delta reconciliation is only sound with one call in flight globally,
 * so this is a correctness requirement, not a throughput knob. Production backs
 * it with a Postgres advisory lock, which survives crashes and deploys because
 * the lock dies with the connection.
 */
export interface AdvisoryLock {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Single-process lock. Correct for one worker; production needs the DB-backed one. */
export class InMemoryLock implements AdvisoryLock {
  private chains = new Map<string, Promise<unknown>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    // Swallow the predecessor's rejection so one failure cannot poison the chain.
    const next = previous.catch(() => undefined).then(fn);
    this.chains.set(
      key,
      next.catch(() => undefined),
    );
    try {
      return await next;
    } finally {
      if (this.chains.get(key) === next) this.chains.delete(key);
    }
  }
}
