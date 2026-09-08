/**
 * Fulfilment engine.
 *
 * Turns one paid order into up to eight provider calls, and guarantees the
 * customer sees a single purchase whatever happens underneath.
 *
 * The rules that matter, in order of importance:
 *
 *   1. Never deliver twice. Diamonds cannot be clawed back out of a player's
 *      account, so an ambiguous call is resolved against the wallet balance and
 *      only ever retried when the balance proves it never landed.
 *   2. Never abandon a paid order. Anything unresolved becomes `needs_review`
 *      with an alert, never a silent failure.
 *   3. Stop spending when something is wrong. An indeterminate outcome halts the
 *      whole order rather than working through the remaining items in the dark.
 */

import {
  resolveAmbiguous,
  type PurchaseOutcome,
  type TopupProvider,
  type UsdTenK,
} from '@levelup/provider';
import type { Alerter, AdvisoryLock, Clock, FulfillmentStore, OrderRecord } from './ports.js';
import { systemClock } from './ports.js';
import { assertTransition, deriveOrderStatus, type OrderStatus } from './states.js';

export const PROVIDER_LOCK_KEY = 'provider:recargasamerica';

export interface FulfillmentConfig {
  /** Attempts per item before it goes to a human. */
  maxAttempts: number;
  /** Pause between provider calls — eight rapid top-ups can trip velocity checks. */
  interCallDelayMs: number;
  /** Keep this much wallet headroom in reserve. */
  reserveFloorUsd: UsdTenK;
}

export const defaultConfig: FulfillmentConfig = {
  maxAttempts: 3,
  interCallDelayMs: 1500,
  reserveFloorUsd: 0 as UsdTenK,
};

export interface FulfillmentDeps {
  store: FulfillmentStore;
  provider: TopupProvider;
  lock: AdvisoryLock;
  alerter: Alerter;
  clock?: Clock;
  config?: Partial<FulfillmentConfig>;
}

export interface FulfillmentResult {
  orderId: string;
  finalStatus: OrderStatus;
  delivered: number;
  attempted: number;
  /** Set when the run stopped early rather than working through every item. */
  haltedReason?: 'indeterminate' | 'code_delivery' | 'insufficient_balance' | 'permanent_failure';
}

/** Orders in these states have nothing for the worker to do. */
const NOT_FULFILLABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'pending_payment',
  'completed',
  'cancelled',
  'payment_expired',
  'refund_required',
]);

export async function fulfillOrder(
  deps: FulfillmentDeps,
  orderId: string,
): Promise<FulfillmentResult> {
  const clock = deps.clock ?? systemClock;
  const config = { ...defaultConfig, ...deps.config };
  const { store, provider, lock, alerter } = deps;

  const order = await store.loadOrder(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);

  if (NOT_FULFILLABLE.has(order.status)) {
    return {
      orderId,
      finalStatus: order.status,
      delivered: order.items.filter((i) => i.status === 'succeeded').length,
      attempted: 0,
    };
  }

  const pending = order.items
    .filter((i) => i.status === 'queued' || i.status === 'failed')
    .filter((i) => i.attemptCount < config.maxAttempts)
    .sort((a, b) => a.sequence - b.sequence);

  if (pending.length === 0) {
    return finish(deps, order, config.maxAttempts, 0);
  }

  // Free Fire products expose no stock field, so wallet balance is the only
  // pre-flight signal. The customer has already paid — better to pause the
  // whole order and alert than to start one we cannot finish.
  const remainingCost = pending.reduce((sum, i) => sum + i.costUsd, 0) as UsdTenK;
  const balance = await provider.getBalance();
  if (balance - config.reserveFloorUsd < remainingCost) {
    await alerter.send('critical', 'Insufficient provider balance — order paused', {
      orderNumber: order.orderNumber,
      balanceUsd: balance / 10_000,
      requiredUsd: remainingCost / 10_000,
    });
    await transition(store, order, 'needs_review');
    return {
      orderId,
      finalStatus: 'needs_review',
      delivered: order.items.filter((i) => i.status === 'succeeded').length,
      attempted: 0,
      haltedReason: 'insufficient_balance',
    };
  }

  await transition(store, order, 'processing');

  let attempted = 0;
  let halted: FulfillmentResult['haltedReason'];

  for (const [index, item] of pending.entries()) {
    if (halted) break;
    if (index > 0 && config.interCallDelayMs > 0) await clock.sleep(config.interCallDelayMs);

    attempted++;

    // Everything from here to settlement holds the global provider lock. Wallet
    // comparison is meaningless if another call moves the balance in between.
    halted = await lock.withLock(PROVIDER_LOCK_KEY, async () => {
      const walletBefore = await provider.getBalance();

      // Committed before the call goes out. If the process dies now, recovery
      // finds a `sending` item and a balance to reconcile against.
      await store.markItemSending(item.id, walletBefore);

      const outcome = await provider.purchase({
        endpointKind: 'pins_recharge',
        providerProductId: item.providerProductId,
        playerId: order.playerId,
        ...(order.serverId ? { serverId: order.serverId } : {}),
        clientReference: `${order.orderNumber}-${item.sequence}`,
      });

      return handleOutcome({
        outcome,
        itemId: item.id,
        costUsd: item.costUsd,
        walletBefore,
        order,
        store,
        provider,
        alerter,
      });
    });
  }

  return finish(deps, order, config.maxAttempts, attempted, halted);
}

interface HandleArgs {
  outcome: PurchaseOutcome;
  itemId: string;
  costUsd: UsdTenK;
  walletBefore: UsdTenK;
  order: OrderRecord;
  store: FulfillmentStore;
  provider: TopupProvider;
  alerter: Alerter;
}

/** Returns a halt reason when the rest of the order must not proceed. */
async function handleOutcome(args: HandleArgs): Promise<FulfillmentResult['haltedReason']> {
  const { outcome, itemId, costUsd, walletBefore, order, store, provider, alerter } = args;

  switch (outcome.kind) {
    case 'succeeded':
      await store.settleItem(itemId, {
        status: 'succeeded',
        providerTransactionId: outcome.providerTransactionId,
        providerReference: outcome.providerReference,
        resolvedBy: 'response',
        responsePayload: outcome,
      });
      return undefined;

    case 'pending':
      // The poller takes it from here; this item is not finished but it is not
      // stuck either, so the run continues.
      await store.settleItem(itemId, {
        status: 'provider_pending',
        providerTransactionId: outcome.providerTransactionId,
        providerReference: outcome.providerReference,
        resolvedBy: 'response',
        responsePayload: outcome,
      });
      return undefined;

    case 'failed': {
      await store.settleItem(itemId, {
        status: 'failed',
        errorCode: outcome.code,
        resolvedBy: 'response',
        responsePayload: outcome,
      });

      // A permanent failure will fail identically next time. Stop rather than
      // burn the remaining items against the same misconfiguration.
      if (!outcome.retryable) {
        await alerter.send('critical', 'Permanent provider failure', {
          orderNumber: order.orderNumber,
          code: outcome.code,
          message: outcome.message,
        });
        return 'permanent_failure';
      }
      return undefined;
    }

    case 'delivered_as_code': {
      // The provider handed back a redeemable code instead of topping up the
      // account. The customer bought a "recarga directa"; stop immediately.
      await store.settleItem(itemId, {
        status: 'unknown',
        providerTransactionId: outcome.providerTransactionId,
        errorCode: 'DELIVERED_AS_CODE',
        resolvedBy: 'response',
        responsePayload: outcome,
      });
      await alerter.send('critical', 'Provider returned a code, not a top-up', {
        orderNumber: order.orderNumber,
        pins: outcome.pins.length,
      });
      return 'code_delivery';
    }

    case 'ambiguous': {
      // The heart of it. No idempotency key exists, so the wallet balance is
      // the only evidence of whether this call landed.
      const walletAfter = await provider.getBalance();
      const resolution = resolveAmbiguous({
        balanceBefore: walletBefore,
        balanceAfter: walletAfter,
        expectedCost: costUsd,
      });

      if (resolution.verdict === 'charged') {
        // It went through despite the error. Record it as delivered — retrying
        // here is exactly how a customer ends up with double diamonds.
        await store.settleItem(itemId, {
          status: 'succeeded',
          walletAfterUsd: walletAfter,
          resolvedBy: 'wallet_delta',
          errorCode: outcome.reason,
          responsePayload: { outcome, resolution },
        });
        await alerter.send('warn', 'Ambiguous call resolved as delivered', {
          orderNumber: order.orderNumber,
          reason: outcome.reason,
        });
        return undefined;
      }

      if (resolution.verdict === 'not_charged') {
        // The balance proves nothing happened, so this is safe to retry.
        await store.settleItem(itemId, {
          status: 'failed',
          walletAfterUsd: walletAfter,
          resolvedBy: 'wallet_delta',
          errorCode: outcome.reason,
          responsePayload: { outcome, resolution },
        });
        return undefined;
      }

      // Indeterminate. Do not guess with money, and do not keep spending while
      // the wallet is telling us something we do not understand.
      await store.settleItem(itemId, {
        status: 'unknown',
        walletAfterUsd: walletAfter,
        resolvedBy: 'wallet_delta',
        errorCode: outcome.reason,
        responsePayload: { outcome, resolution },
      });
      await alerter.send('critical', 'Order halted — cannot determine delivery', {
        orderNumber: order.orderNumber,
        reason: resolution.reason,
        observedDeltaUsd: resolution.observedDelta / 10_000,
      });
      return 'indeterminate';
    }
  }
}

async function transition(
  store: FulfillmentStore,
  order: OrderRecord,
  to: OrderStatus,
): Promise<void> {
  if (order.status === to) return;
  assertTransition(order.status, to);
  await store.updateOrderStatus(order.id, to);
  order.status = to;
}

async function finish(
  deps: FulfillmentDeps,
  order: OrderRecord,
  maxAttempts: number,
  attempted: number,
  haltedReason?: FulfillmentResult['haltedReason'],
): Promise<FulfillmentResult> {
  const fresh = (await deps.store.loadOrder(order.id)) ?? order;
  const derived = deriveOrderStatus(fresh.items, maxAttempts);

  // A halt always means a human is needed, whatever the items alone imply.
  const finalStatus: OrderStatus = haltedReason ? 'needs_review' : derived;

  if (fresh.status !== finalStatus) {
    assertTransition(fresh.status, finalStatus);
    await deps.store.updateOrderStatus(order.id, finalStatus);
  }

  if (finalStatus === 'needs_review' && !haltedReason) {
    await deps.alerter.send('critical', 'Order needs manual review', {
      orderNumber: fresh.orderNumber,
    });
  }

  return {
    orderId: order.id,
    finalStatus,
    delivered: fresh.items.filter((i) => i.status === 'succeeded').length,
    attempted,
    ...(haltedReason ? { haltedReason } : {}),
  };
}
