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

import {
  resolveAmbiguous,
  type ProviderName,
  type TopupProvider,
  type UsdTenK,
} from '@levelup/provider';
import type { Alerter, AdvisoryLock, Clock, FulfillmentStore } from './ports.js';
import { systemClock } from './ports.js';
import { PROVIDER_LOCK_KEYS } from './fulfillment.js';
import { deriveOrderStatus, type OrderStatus } from './states.js';

export interface StalledItem {
  orderId: string;
  orderNumber: string;
  itemId: string;
  provider: ProviderName;
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
  providers: Record<ProviderName, TopupProvider>;
  lock: AdvisoryLock & {
    tryWithLock?<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
  };
  alerter: Alerter;
  clock?: Clock;
  config?: Partial<PollerConfig>;
  /**
   * Recovery runs on its own sweep, independent of the claim loop — so it can
   * land a crashed order back on an automatically-claimable status (e.g.
   * `processing`, with items still `queued`) even while emergency mode is on,
   * which `holdForManualFulfillment` never gets a chance to catch until that
   * order next goes stale. `refreshOrderStatus` checks this itself so the gap
   * closes immediately instead of one staleness window later. Optional, and
   * treated as "off" when omitted, so the many tests here that do not care
   * about emergency mode do not all need to supply it.
   */
  isEmergencyMode?: () => Promise<boolean>;
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
  const { store } = deps;

  const items = await store.findPendingProviderItems(config.minAgeMs, config.batchSize);
  if (items.length === 0) return empty();

  const result = empty();
  result.examined = items.length;

  for (const item of items) {
    try {
      await pollOne(deps, config, item, result);
    } catch (err) {
      // Most likely `settleItem` lost a race — a live call that stalled past
      // `minAgeMs` finally answered and settled this item in between this
      // batch being read and reaching it. Nothing wrong to report; someone
      // else already resolved it. Skip rather than let one item's race, or a
      // genuine transient error, abort the rest of the batch.
      console.warn(`[poller] skipping ${item.itemId}: ${String(err)}`);
    }
  }

  return result;
}

async function pollOne(
  deps: PollerDeps,
  config: PollerConfig,
  item: StalledItem,
  result: SweepResult,
): Promise<void> {
  const { store, providers } = deps;
  const provider = providers[item.provider];

  if (!item.providerReference) {
    // PENDING with no reference is unpollable — it can only ever be resolved
    // by a human against the provider's panel.
    await store.settleItem(item.itemId, { status: 'unknown', errorCode: 'NO_REFERENCE' });
    await escalate(deps, item, 'PENDING item has no provider reference to poll');
    result.escalated++;
    return;
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
      return;
    }

    await store.settleItem(item.itemId, {
      status: 'succeeded',
      resolvedBy: 'polling',
      responsePayload: status,
    });
    result.completed++;
    await refreshOrderStatus(deps, item.orderId, config.maxAttempts);
    return;
  }

  if (status === null) {
    // The provider does not recognise a reference it gave us. Never guess.
    await store.settleItem(item.itemId, { status: 'unknown', errorCode: 'REFERENCE_NOT_FOUND' });
    await escalate(deps, item, 'Provider no longer recognises the order reference');
    result.escalated++;
    return;
  }

  if (item.ageMs >= config.escalateAfterMs) {
    await store.settleItem(item.itemId, { status: 'unknown', errorCode: 'PENDING_TIMEOUT' });
    await escalate(deps, item, `Still PENDING after ${Math.round(item.ageMs / 60_000)} minutes`);
    result.escalated++;
    return;
  }

  result.stillPending++;
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
  const { store, lock } = deps;

  const items = await store.findStalledSendingItems(config.minAgeMs, config.batchSize);
  if (items.length === 0) return empty();

  // Grouped by provider so each gets its own lock — a busy RA combo must not
  // block recovering a stalled Central One item, and vice versa. Groups run
  // concurrently (see below), so in the rare case where one order's items
  // span both providers and both are stalled in the same sweep, their two
  // `refreshOrderStatus` calls could race on that one order's status. Never a
  // money-correctness issue — `settleItem` is still a safe per-item write
  // either way — and self-heals on the very next sweep, which re-derives the
  // order's status from scratch regardless of what the last write left it at.
  const byProvider = new Map<ProviderName, StalledItem[]>();
  for (const item of items) {
    const list = byProvider.get(item.provider) ?? [];
    list.push(item);
    byProvider.set(item.provider, list);
  }

  // Run every provider's group concurrently, not one after another — with an
  // `AdvisoryLock` that only implements `withLock` (queues rather than skips,
  // e.g. `InMemoryLock`), awaiting each group in sequence would serialise a
  // busy RA lock in front of Central One's recovery even though they use
  // different keys. Launching them together lets each group's own lock
  // acquisition proceed independently.
  const outcomes = await Promise.all(
    [...byProvider.entries()].map(async ([providerName, providerItems]) => {
      const run = async (): Promise<SweepResult> => {
        const result = empty();
        result.examined = providerItems.length;

        for (const item of providerItems) {
          try {
            await recoverOne(deps, config, item, result);
          } catch (err) {
            // Most likely `settleItem` lost a race against another writer for
            // the same item — see the equivalent catch in `pollPendingOrders`.
            // Skip it rather than abort the rest of the batch.
            console.warn(`[poller] skipping ${item.itemId}: ${String(err)}`);
          }
        }

        return result;
      };

      // Skip rather than queue: a live combo holds this provider's lock, and
      // its own in-process reconciliation already covers everything this
      // group would look at.
      return typeof lock.tryWithLock === 'function'
        ? await lock.tryWithLock(PROVIDER_LOCK_KEYS[providerName], run)
        : await lock.withLock(PROVIDER_LOCK_KEYS[providerName], run);
    }),
  );

  const total = empty();
  let anyRan = false;
  for (const outcome of outcomes) {
    if (!outcome) continue;
    anyRan = true;
    total.examined += outcome.examined;
    total.completed += outcome.completed;
    total.stillPending += outcome.stillPending;
    total.escalated += outcome.escalated;
    total.resolvedByWallet += outcome.resolvedByWallet;
  }

  total.skipped = !anyRan;
  return total;
}

async function recoverOne(
  deps: PollerDeps,
  config: PollerConfig,
  item: StalledItem,
  result: SweepResult,
): Promise<void> {
  const { store, providers, alerter } = deps;
  const provider = providers[item.provider];

  if (item.walletBeforeUsd === null) {
    // No pre-call snapshot means nothing to compare against.
    await store.settleItem(item.itemId, { status: 'unknown', errorCode: 'NO_WALLET_SNAPSHOT' });
    await escalate(deps, item, 'Stalled mid-send with no wallet snapshot to reconcile');
    result.escalated++;
    return;
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

  await refreshOrderStatus(deps, item.orderId, config.maxAttempts);
}

async function refreshOrderStatus(
  deps: Pick<PollerDeps, 'store' | 'alerter' | 'isEmergencyMode'>,
  orderId: string,
  maxAttempts: number,
): Promise<void> {
  const { store, alerter, isEmergencyMode } = deps;
  const order = await store.loadOrder(orderId);
  if (!order) return;

  let derived: OrderStatus = deriveOrderStatus(order.items, maxAttempts);

  // Only overridden when there is still unattempted/unexhausted work ahead —
  // a recovery that finishes the order outright (`completed`) is left alone,
  // since nothing automatic remains to protect against.
  if (isEmergencyMode && (derived === 'processing' || derived === 'partially_delivered')) {
    let emergency = false;
    try {
      emergency = await isEmergencyMode();
    } catch (err) {
      console.error(`[poller] Could not read emergency mode, leaving ${order.orderNumber} on its derived status: ${String(err)}`);
    }
    if (emergency) derived = 'needs_review';
  }

  if (derived === order.status) return;
  await store.updateOrderStatus(orderId, derived);
  if (derived === 'needs_review') {
    await alerter.send('warn', 'Emergency mode — order held for manual fulfillment', {
      orderNumber: order.orderNumber,
    });
  }
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
