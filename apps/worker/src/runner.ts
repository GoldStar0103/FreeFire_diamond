/**
 * The worker's two loops, and the catalog sync that rides on the sweep.
 *
 * Extracted from `main.ts` so all of it can be driven directly by tests — the
 * shutdown behaviour in particular is the sort of thing that only ever gets
 * exercised in production otherwise.
 */

import {
  closeDueSeasons,
  createPendingRewardOrders,
  expireOverduePayments,
  fulfillOrder,
  grantCompletedRewardOrders,
  PROVIDER_LOCK_KEY,
  recoverStalledItems,
  pollPendingOrders,
  reportConversions,
  summariseSync,
  syncCatalog,
  syncLevelPass,
} from '@levelup/engine';
import type {
  Alerter,
  AdvisoryLock,
  CatalogSyncResult,
  CatalogSyncStore,
  ConversionDeps,
  ConversionResult,
  ExpiryStore,
  LevelPassSweepResult,
  LevelPassSweepStore,
  RecoveryStore,
  RewardFulfillmentStore,
  SeasonCloseResult,
  SeasonStore,
  StuckPaymentStore,
} from '@levelup/engine';
import type { TopupProvider, UsdTenK } from '@levelup/provider';
import type { DrizzleOrderQueue } from '@levelup/db';
import { catalogSyncAlerts } from './catalog-report.js';
import type { WorkerConfig } from './config.js';

export interface RunnerDeps {
  queue: Pick<DrizzleOrderQueue, 'claimNext' | 'depth'>;
  store: RecoveryStore & ExpiryStore & StuckPaymentStore;
  /** The `base_products` mirror, for the periodic provider catalog sync. */
  catalog: CatalogSyncStore;
  provider: TopupProvider;
  lock: AdvisoryLock;
  /**
   * In-process mutex around each whole order — see `ORDER_BOUNDARY_KEY`.
   * `InMemoryLock` in production: the worker is a single process by design.
   */
  orderBoundary: AdvisoryLock;
  alerter: Alerter;
  config: WorkerConfig;
}

/**
 * Held for the whole of one `fulfillOrder` call, and by the catalog sync.
 *
 * The provider advisory lock alone is not enough to keep a re-point away from
 * a combo in flight. `fulfillOrder` loads the order once, then takes the
 * provider lock per call and releases it for the pacing delay between calls —
 * so a sync could slip into that gap and re-point items 4 to 8 in the database
 * while the loop still holds their old ids and old costs in memory. It would
 * then dispatch to the retired id and reconcile against the retired price.
 * Serialising the sync against whole orders closes that gap: the sync waits
 * for the combo in hand to finish, and the next order loads fresh.
 */
export const ORDER_BOUNDARY_KEY = 'worker:order-boundary';

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
  const { queue, store, provider, lock, orderBoundary, alerter, config } = deps;
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
      const result = await orderBoundary.withLock(ORDER_BOUNDARY_KEY, () =>
        fulfillOrder(
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
        ),
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

  try {
    // Retires orders nobody ever paid for. Cheap, and it is what frees a Mega
    // Oferta slot that an abandoned attempt would otherwise hold forever.
    const expiry = await expireOverduePayments({
      store,
      config: { batchSize: config.sweeps.batchSize },
    });
    if (expiry.expired > 0 || expiry.failed > 0) {
      console.log(`[sweep] expired ${expiry.expired} unpaid order(s), ${expiry.failed} failed`);
    }
  } catch (err) {
    console.error(`[sweep] Expiry failed: ${String(err)}`);
  }

  // No Telegram alert for a pending OXXO/SPEI payment sitting quiet past a
  // few hours any more (removed 2026-09-27, client request): the large
  // majority turned out to be customers who generated a payment reference
  // and never intended to pay it, not a real settlement problem — the alert
  // was mostly noise. `listStuckGatewayPayments` (admin-queries.ts) still
  // shows the current list on Inicio for the client to check and dismiss by
  // hand; `alertStuckGatewayPayments` (engine/stuck-payments.ts) is kept,
  // unused, in case this needs to come back.

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

/**
 * One provider catalog sync, as the worker runs it.
 *
 * Before this ran on its own the sync was a CLI someone had to remember, so a
 * provider changing its ids would have surfaced as customers complaining that
 * nothing could be bought. Now the worker notices within the hour and either
 * follows the change (re-pointing recipes and unsent items) or says loudly that
 * it could not.
 *
 * Lock order is the same as fulfilment's — order boundary, then provider — so
 * the two cannot deadlock. The provider lock is what guarantees no item is
 * re-pointed while its own call is in flight; see `ORDER_BOUNDARY_KEY` for why
 * the boundary is needed on top.
 *
 * Returns null when the sync threw. Like every sweep step, a failure is logged
 * and survived: a catalog endpoint having a bad minute must not stop the
 * worker delivering orders that are already paid for.
 */
export async function runCatalogSync(deps: RunnerDeps): Promise<CatalogSyncResult | null> {
  const { catalog, provider, lock, orderBoundary, alerter } = deps;

  // The `Alerter` contract is never to throw, but this runs on the sweep loop
  // and a broken alerter must not be what stops it.
  const send: Alerter['send'] = (level, title, detail) =>
    alerter.send(level, title, detail).catch((err: unknown) => {
      console.error(`[catalog] Could not send alert "${title}": ${String(err)}`);
    });

  let result: CatalogSyncResult;
  try {
    result = await orderBoundary.withLock(ORDER_BOUNDARY_KEY, () =>
      lock.withLock(PROVIDER_LOCK_KEY, () => syncCatalog({ store: catalog, provider })),
    );
  } catch (err) {
    console.error(`[catalog] Sync failed: ${String(err)}`);
    // Warn, not critical: a failed sync changes nothing — the previous catalog
    // stays exactly as it was — and the retry comes round shortly. If the
    // provider's purchase endpoints are down too, fulfilment says so itself.
    await send('warn', 'Provider catalog sync failed — will retry', { error: String(err) });
    return null;
  }

  const alerts = catalogSyncAlerts(result);
  const line = `[catalog] ${summariseSync(result)}`;
  if (alerts.length > 0) console.warn(line);
  else console.log(line);

  for (const alert of alerts) await send(alert.level, alert.title, alert.detail);
  return result;
}

/** After a failed sync, try again this soon rather than a full interval later. */
export const CATALOG_SYNC_RETRY_MS = 5 * 60_000;

/**
 * When the next catalog sync is due.
 *
 * Driven from the sweep loop rather than a timer of its own, so it inherits the
 * sweep's shutdown handling and can never run twice at once. The first call is
 * always due — that is the startup sync, which `main.ts` runs before the
 * fulfilment loop claims anything, so a worker restarted after the provider
 * changed its catalog overnight does not dispatch its first orders to dead ids.
 */
export class CatalogSyncSchedule {
  private nextAt: number | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly retryMs: number = CATALOG_SYNC_RETRY_MS,
  ) {}

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  isDue(now: number): boolean {
    return this.enabled && (this.nextAt === null || now >= this.nextAt);
  }

  async runIfDue(
    deps: RunnerDeps,
    now: number = Date.now(),
  ): Promise<{ ran: boolean; result: CatalogSyncResult | null }> {
    if (!this.isDue(now)) return { ran: false, result: null };

    const result = await runCatalogSync(deps);
    // Scheduled from when the run was due, not when it finished, and sooner
    // after a failure: on the day the provider migrates, an hour between
    // attempts is an hour of not knowing.
    this.nextAt = now + (result ? this.intervalMs : Math.min(this.intervalMs, this.retryMs));
    return { ran: true, result };
  }
}

/**
 * Report newly paid orders to Meta. Attribution only — it never touches the
 * provider, holds no lock, and a failure here must not disturb anything that
 * delivers diamonds, so it is caught and logged like every other sweep step.
 */
export async function runConversions(deps: ConversionDeps): Promise<ConversionResult | null> {
  try {
    const result = await reportConversions(deps);
    if (result.examined > 0) {
      console.log(
        `[conversions] ${result.reported} reported, ${result.failed} failed` +
          `${result.gaveUp ? `, ${result.gaveUp} given up` : ''}`,
      );
    }
    return result;
  } catch (err) {
    console.error(`[conversions] Sweep failed: ${String(err)}`);
    return null;
  }
}

/**
 * Credit Level Points for newly completed orders. Same shape as
 * `runConversions`: a separate, optional dep bundle rather than folded into
 * `RunnerDeps`/`runSweepOnce`, since this touches nothing fulfilment needs and
 * a failure here must never hold up a delivery. Harmless before any season
 * exists — `syncLevelPass` finds completed orders, `processOrderCompletion`
 * reports `no_active_season` for each, counted as a skip, not a failure.
 */
export interface LevelPassSweepDeps {
  store: LevelPassSweepStore;
  lookbackMs: number;
  batchSize: number;
}

export async function runLevelPassSync(deps: LevelPassSweepDeps): Promise<LevelPassSweepResult | null> {
  try {
    const result = await syncLevelPass(deps);
    if (result.examined > 0) {
      console.log(
        `[level-pass] ${result.applied} applied, ${result.skipped} skipped, ${result.failed} failed`,
      );
    }
    return result;
  } catch (err) {
    console.error(`[level-pass] Sweep failed: ${String(err)}`);
    return null;
  }
}

/**
 * Close any season past its end date: freeze the ranking, award badges, open
 * the next one. Same "separate optional dep bundle" shape as above.
 */
export async function runSeasonClose(deps: { store: SeasonStore }): Promise<SeasonCloseResult | null> {
  try {
    const result = await closeDueSeasons(deps);
    if (result.closed.length > 0 || result.failed > 0) {
      console.log(`[seasons] closed ${result.closed.length}, ${result.failed} failed`);
    }
    return result;
  } catch (err) {
    console.error(`[seasons] Sweep failed: ${String(err)}`);
    return null;
  }
}

/**
 * Level Pass reward delivery, in two halves: turn a reached checkpoint into a
 * real `$0` order (which `runFulfillmentLoop`/the poller above then deliver
 * like any other order, on their own next pass), then close the loop for
 * whichever of those orders has since completed. Same "separate optional dep
 * bundle" shape as `runLevelPassSync` — a failure here must never hold up a
 * real delivery.
 */
export async function runRewardDelivery(
  deps: { store: RewardFulfillmentStore },
  batchSize: number,
): Promise<void> {
  try {
    const created = await createPendingRewardOrders(deps, batchSize);
    if (created.examined > 0) {
      console.log(
        `[rewards] ${created.created} order(s) created, ${created.unresolved} unresolved, ${created.failed} failed`,
      );
    }
  } catch (err) {
    console.error(`[rewards] Could not create pending reward orders: ${String(err)}`);
  }

  try {
    const granted = await grantCompletedRewardOrders(deps, batchSize);
    if (granted.examined > 0) {
      console.log(`[rewards] ${granted.granted} granted, ${granted.failed} failed`);
    }
  } catch (err) {
    console.error(`[rewards] Could not grant completed reward orders: ${String(err)}`);
  }
}
