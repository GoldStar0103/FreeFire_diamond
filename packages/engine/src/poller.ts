/**
 * PENDING poller and stalled-order recovery.
 *
 * Two gaps the fulfilment run itself cannot close:
 *
 * 1. `/buy/games` can answer PENDING. The provider sends no webhook, so the
 *    only way to learn the outcome is to ask — repeatedly, with a ceiling.
 *
 * 2. A worker can die between committing a `sending` row and settling it. That
 *    row is the evidence the call was attempted; recovery reconciles it against
 *    the wallet exactly as an in-process timeout would be.
 *
 * Both run under `tryWithLock`: if a combo is mid-flight, there is nothing
 * useful to do and blocking would just stack timers behind it.
 */

import { resolveAmbiguous, type TopupProvider, type UsdTenK } from '@levelup/provider';
import type { Alerter, AdvisoryLock, Clock, FulfillmentStore } from './ports.js';
import { systemClock } from './ports.js';
import { PROVIDER_LOCK_KEY } from './fulfillment.js';
import { deriveOrderStatus, type OrderStatus } from './states.js';

export interface StalledItem {
  orderId: string;
  orderNumber: string;
  itemId: string;
  providerReference: string | null;
  costUsd: UsdTenK;
  walletBeforeUsd: UsdTenK | null;
  /** How long the item has sat in `sending` or `provider_pending`. */
  ageMs: number;
  attemptCount: number;
}

/** Read side the crons need, beyond what fulfilment itself uses. */
export interface RecoveryStore extends FulfillmentStore {
  findPendingProviderItems(olderThanMs: number, limit: number): Promise<StalledItem[]>;
  findStalledSendingItems(olderThanMs: number, limit: number): Promise<StalledItem[]>;
}

export interface PollerConfig {
  /** Only look at items that have had time to settle on their own. */
  minAgeMs: number;
  /** Give up polling and escalate past this age. */
  escalateAfterMs: number;
  batchSize: number;
  maxAttempts: number;
}

export const defaultPollerConfig: PollerConfig = {
  minAgeMs: 30_000,
  escalateAfterMs: 15 * 60_000,
  batchSize: 25,
  maxAttempts: 3,
};

export interface PollerDeps {
  store: RecoveryStore;
  provider: TopupProvider;
  lock: AdvisoryLock & {
    tryWithLock?<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
  };
  alerter: Alerter;
  clock?: Clock;
  config?: Partial<PollerConfig>;
}

export interface SweepResult {
  examined: number;
  completed: number;
  stillPending: number;
  escalated: number;
  resolvedByWallet: number;
  skipped: boolean;
}

const empty = (skipped = false): SweepResult => ({
  examined: 0,
  completed: 0,
  stillPending: 0,
  escalated: 0,
  resolvedByWallet: 0,
  skipped,
});

/** Poll provider-side PENDING orders and settle the ones that finished. */
export async function pollPendingOrders(deps: PollerDeps): Promise<SweepResult> {
  const config = { ...defaultPollerConfig, ...deps.config };
  const { store, provider, alerter } = deps;

  const items = await store.findPendingProviderItems(config.minAgeMs, config.batchSize);
  if (items.length === 0) return empty();

  const result = empty();
  result.examined = items.length;

  for (const item of items) {
    if (!item.providerReference) {
      // PENDING with no reference is unpollable — it can only ever be resolved
      // by a human against the provider's panel.
      await store.settleItem(item.itemId, { status: 'unknown', errorCode: 'NO_REFERENCE' });
      await escalate(deps, item, 'PENDING item has no provider reference to poll');
      result.escalated++;
      continue;
    }

    const status = await provider.getOrderStatus(item.providerReference);

    if (status?.status === 'COMPLETED') {
      // A populated `pins` array means codes, not a top-up — the same
      // project-breaking case the purchase path guards against.
      if (status.pins.length > 0) {
        await store.settleItem(item.itemId, {
          status: 'unknown',
          errorCode: 'DELIVERED_AS_CODE',
          resolvedBy: 'polling',
          responsePayload: status,
        });
        await escalate(deps, item, 'Provider delivered a code rather than a top-up');
        result.escalated++;
        continue;
      }

      await store.settleItem(item.itemId, {
        status: 'succeeded',
        resolvedBy: 'polling',
        responsePayload: status,
      });
      result.completed++;
      await refreshOrderStatus(store, item.orderId, config.maxAttempts);
      continue;
    }

    if (status === null) {
      // The provider does not recognise a reference it gave us. Never guess.
      await store.settleItem(item.itemId, { status: 'unknown', errorCode: 'REFERENCE_NOT_FOUND' });
      await escalate(deps, item, 'Provider no longer recognises the order reference');
      result.escalated++;
      continue;
    }

    if (item.ageMs >= config.escalateAfterMs) {
      await store.settleItem(item.itemId, { status: 'unknown', errorCode: 'PENDING_TIMEOUT' });
      await escalate(
        deps,
        item,
        `Still PENDING after ${Math.round(item.ageMs / 60_000)} minutes`,
      );
      result.escalated++;
      continue;
    }

    result.stillPending++;
  }

  return result;
}

/**
 * Recover items stuck in `sending` — a worker died mid-call.
 *
 * This is the same wallet-delta reconciliation the in-process path uses, which
 * is why the `sending` row had to be committed before the HTTP request. It runs
 * under the provider lock so no live call can move the balance underneath it.
 */
export async function recoverStalledItems(deps: PollerDeps): Promise<SweepResult> {
  const config = { ...defaultPollerConfig, ...deps.config };
  const { store, provider, lock, alerter } = deps;

  const run = async (): Promise<SweepResult> => {
    const items = await store.findStalledSendingItems(config.minAgeMs, config.batchSize);
    if (items.length === 0) return empty();

    const result = empty();
    result.examined = items.length;

    for (const item of items) {
      if (item.walletBeforeUsd === null) {
        // No pre-call snapshot means nothing to compare against.
        await store.settleItem(item.itemId, { status: 'unknown', errorCode: 'NO_WALLET_SNAPSHOT' });
        await escalate(deps, item, 'Stalled mid-send with no wallet snapshot to reconcile');
        result.escalated++;
        continue;
      }

      const balanceAfter = await provider.getBalance();
      const resolution = resolveAmbiguous({
        balanceBefore: item.walletBeforeUsd,
        balanceAfter,
        expectedCost: item.costUsd,
      });

      if (resolution.verdict === 'charged') {
        await store.settleItem(item.itemId, {
          status: 'succeeded',
          walletAfterUsd: balanceAfter,
          resolvedBy: 'wallet_delta',
          errorCode: 'RECOVERED_AFTER_CRASH',
        });
        result.resolvedByWallet++;
        await alerter.send('warn', 'Recovered a crashed call as delivered', {
          orderNumber: item.orderNumber,
        });
      } else if (resolution.verdict === 'not_charged') {
        // Never landed, so it is safe to put back in the queue.
        await store.settleItem(item.itemId, {
          status: item.attemptCount >= config.maxAttempts ? 'unknown' : 'failed',
          walletAfterUsd: balanceAfter,
          resolvedBy: 'wallet_delta',
          errorCode: 'RECOVERED_NOT_CHARGED',
        });
        result.resolvedByWallet++;
      } else {
        await store.settleItem(item.itemId, {
          status: 'unknown',
          walletAfterUsd: balanceAfter,
          resolvedBy: 'wallet_delta',
          errorCode: 'RECOVERY_INDETERMINATE',
        });
        await escalate(deps, item, resolution.reason);
        result.escalated++;
      }

      await refreshOrderStatus(store, item.orderId, config.maxAttempts);
    }

    return result;
  };

  // Skip rather than queue: a live combo holds the lock, and its own in-process
  // reconciliation already covers everything this sweep would look at.
  if (typeof lock.tryWithLock === 'function') {
    return (await lock.tryWithLock(PROVIDER_LOCK_KEY, run)) ?? empty(true);
  }
  return lock.withLock(PROVIDER_LOCK_KEY, run);
}

async function refreshOrderStatus(
  store: FulfillmentStore,
  orderId: string,
  maxAttempts: number,
): Promise<void> {
  const order = await store.loadOrder(orderId);
  if (!order) return;
  const derived: OrderStatus = deriveOrderStatus(order.items, maxAttempts);
  if (derived !== order.status) await store.updateOrderStatus(orderId, derived);
}

async function escalate(deps: PollerDeps, item: StalledItem, reason: string): Promise<void> {
  await deps.store.updateOrderStatus(item.orderId, 'needs_review');
  await deps.alerter.send('critical', 'Order needs manual review', {
    orderNumber: item.orderNumber,
    itemId: item.itemId,
    reason,
  });
}

/** Convenience wrapper for the cron: poll first, then recover. */
export async function sweep(deps: PollerDeps): Promise<{
  polling: SweepResult;
  recovery: SweepResult;
}> {
  const clock = deps.clock ?? systemClock;
  void clock;
  return {
    polling: await pollPendingOrders(deps),
    recovery: await recoverStalledItems(deps),
  };
}
