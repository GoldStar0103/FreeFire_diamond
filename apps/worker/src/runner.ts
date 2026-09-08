/**
 * The worker's two loops.
 *
 * Extracted from `main.ts` so both can be driven directly by tests — the
 * shutdown behaviour in particular is the sort of thing that only ever gets
 * exercised in production otherwise.
 */

import { fulfillOrder, recoverStalledItems, pollPendingOrders } from '@levelup/engine';
import type { Alerter, AdvisoryLock, RecoveryStore } from '@levelup/engine';
import type { TopupProvider, UsdTenK } from '@levelup/provider';
import type { DrizzleOrderQueue } from '@levelup/db';
import type { WorkerConfig } from './config.js';

export interface RunnerDeps {
  queue: Pick<DrizzleOrderQueue, 'claimNext' | 'depth'>;
  store: RecoveryStore;
  provider: TopupProvider;
  lock: AdvisoryLock;
  alerter: Alerter;
  config: WorkerConfig;
}

/** Cooperative stop flag, so a combo mid-flight is never abandoned. */
export class ShutdownSignal {
  private stopped = false;
  stop(): void {
    this.stopped = true;
  }
  get requested(): boolean {
    return this.stopped;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Claim and fulfil orders until asked to stop.
 *
 * The shutdown check sits between orders, never inside one. A SIGTERM during
 * an eight-call combo lets the combo finish; killing it mid-way would leave a
 * paid customer partially delivered for no reason.
 */
export async function runFulfillmentLoop(
  deps: RunnerDeps,
  signal: ShutdownSignal,
  options: { maxIterations?: number } = {},
): Promise<{ processed: number }> {
  const { queue, store, provider, lock, alerter, config } = deps;
  let processed = 0;
  let iterations = 0;

  while (!signal.requested) {
    if (options.maxIterations !== undefined && iterations >= options.maxIterations) break;
    iterations++;

    let claimed;
    try {
      claimed = await queue.claimNext(config.fulfillment.staleOrderMs);
    } catch (err) {
      // A database blip must not kill the worker; back off and try again.
      console.error(`[worker] Could not claim an order: ${String(err)}`);
      await sleep(config.fulfillment.idlePollMs);
      continue;
    }

    if (!claimed) {
      await sleep(config.fulfillment.idlePollMs);
      continue;
    }

    if (claimed.recovered) {
      console.warn(`[worker] Recovered abandoned order ${claimed.orderNumber}`);
    }

    try {
      const result = await fulfillOrder(
        {
          store,
          provider,
          lock,
          alerter,
          config: {
            maxAttempts: config.fulfillment.maxAttempts,
            interCallDelayMs: config.provider.interCallDelayMs,
          },
        },
        claimed.id,
      );
      processed++;
      console.log(
        `[worker] ${claimed.orderNumber} -> ${result.finalStatus} ` +
          `(${result.delivered} delivered, ${result.attempted} attempted` +
          `${result.haltedReason ? `, halted: ${result.haltedReason}` : ''})`,
      );
    } catch (err) {
      // The order stays `processing`; the staleness window will bring it back.
      // Deliberately not marked failed — we do not know what the provider did.
      console.error(`[worker] Order ${claimed.orderNumber} threw: ${String(err)}`);
      await alerter.send('critical', 'Fulfilment threw an unexpected error', {
        orderNumber: claimed.orderNumber,
        error: String(err),
      });
    }
  }

  return { processed };
}

/** Poll PENDING orders, recover dead-worker items, watch the wallet. */
export async function runSweepOnce(deps: RunnerDeps): Promise<void> {
  const { store, provider, lock, alerter, config } = deps;
  const pollerDeps = {
    store,
    provider,
    lock,
    alerter,
    config: {
      minAgeMs: config.sweeps.minAgeMs,
      escalateAfterMs: config.sweeps.escalateAfterMs,
      batchSize: config.sweeps.batchSize,
      maxAttempts: config.fulfillment.maxAttempts,
    },
  };

  try {
    const polled = await pollPendingOrders(pollerDeps);
    if (polled.examined > 0) {
      console.log(
        `[sweep] polled ${polled.examined}: ${polled.completed} completed, ` +
          `${polled.stillPending} pending, ${polled.escalated} escalated`,
      );
    }
  } catch (err) {
    console.error(`[sweep] Polling failed: ${String(err)}`);
  }

  try {
    const recovered = await recoverStalledItems(pollerDeps);
    if (recovered.examined > 0) {
      console.log(
        `[sweep] recovered ${recovered.examined}: ` +
          `${recovered.resolvedByWallet} by wallet, ${recovered.escalated} escalated`,
      );
    }
  } catch (err) {
    console.error(`[sweep] Recovery failed: ${String(err)}`);
  }

  await checkWallet(deps);
}

/**
 * Wallet watch.
 *
 * Free Fire products carry no stock signal, so balance is the only warning we
 * get before paid orders start failing. Alerting early is what turns "orders
 * are failing" into "top up the wallet".
 */
export async function checkWallet(deps: RunnerDeps): Promise<void> {
  const { provider, alerter, queue, config } = deps;
  try {
    const balance = await provider.getBalance();
    const threshold = Math.round(config.provider.lowBalanceUsd * 10_000) as UsdTenK;

    if (balance < threshold) {
      const depth = await queue.depth().catch(() => ({}));
      await alerter.send('critical', 'Provider wallet is low', {
        balanceUsd: (balance / 10_000).toFixed(2),
        thresholdUsd: config.provider.lowBalanceUsd,
        outstandingOrders: JSON.stringify(depth),
      });
    }
  } catch (err) {
    console.error(`[sweep] Could not read wallet balance: ${String(err)}`);
  }
}
