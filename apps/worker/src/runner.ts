/**
 * The worker's two loops, and the catalog sync that rides on the sweep.
 *
 * Extracted from `main.ts` so all of it can be driven directly by tests — the
 * shutdown behaviour in particular is the sort of thing that only ever gets
 * exercised in production otherwise.
 */

import {
  closeDueSeasons,
  createPendingGiveawayPrizeOrders,
  createPendingRewardOrders,
  expireOverduePayments,
  fulfillItemOrder,
  fulfillOrder,
  grantCompletedGiveawayPrizes,
  grantCompletedRewardOrders,
  holdForManualFulfillment,
  PROVIDER_LOCK_KEYS,
  recoverStalledItems,
  pollPendingOrders,
  reportConversions,
  sendExpiryReminders,
  summariseSync,
  syncCatalog,
  syncLevelPass,
  syncRocketPassCatalog,
} from '@levelup/engine';
import type {
  Alerter,
  AdvisoryLock,
  CatalogSyncResult,
  CatalogSyncStore,
  ConversionDeps,
  ConversionResult,
  ExpiryReminderDeps,
  ExpiryReminderResult,
  ExpiryStore,
  GiveawayPrizeDeliveryStore,
  ItemFulfillmentStore,
  LevelPassSweepResult,
  LevelPassSweepStore,
  RecoveryStore,
  RewardFulfillmentStore,
  RocketPassOrderClient,
  RocketPassSyncDeps,
  RocketPassSyncResult,
  SeasonCloseResult,
  SeasonStore,
  StuckPaymentStore,
} from '@levelup/engine';
import type { ProviderName, TopupProvider, UsdTenK } from '@levelup/provider';
import type { DrizzleGiveawayAdminStore, DrizzleOrderQueue } from '@levelup/db';
import { catalogSyncAlerts } from './catalog-report.js';
import type { WorkerConfig } from './config.js';

/** Iterated wherever every provider needs the same treatment (wallet check, catalog sync). */
const PROVIDER_NAMES: readonly ProviderName[] = ['recargas_america', 'central_one'];

export interface RunnerDeps {
  queue: Pick<DrizzleOrderQueue, 'claimNext' | 'depth'>;
  store: RecoveryStore & ExpiryStore & StuckPaymentStore;
  /** The `base_products` mirror, for the periodic provider catalog sync. */
  catalog: CatalogSyncStore;
  providers: Record<ProviderName, TopupProvider>;
  lock: AdvisoryLock;
  /**
   * In-process mutex around each whole order — see `ORDER_BOUNDARY_KEY`.
   * `InMemoryLock` in production: the worker is a single process by design.
   */
  orderBoundary: AdvisoryLock;
  alerter: Alerter;
  config: WorkerConfig;
  /**
   * Whether emergency mode is on right now — read fresh on every claim, not
   * cached in `config`, because the owner flips this from the dashboard while
   * the worker keeps running. A read failure is treated as "off": a transient
   * DB hiccup must not silently stall paid orders with no visible reason.
   */
  isEmergencyMode: () => Promise<boolean>;
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
  const { queue, store, providers, lock, orderBoundary, alerter, config, isEmergencyMode } = deps;
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

    let emergency = false;
    try {
      emergency = await isEmergencyMode();
    } catch (err) {
      console.error(`[worker] Could not read emergency mode, defaulting to automatic: ${String(err)}`);
    }

    if (emergency) {
      try {
        await orderBoundary.withLock(ORDER_BOUNDARY_KEY, () =>
          holdForManualFulfillment({ store, alerter }, claimed.id),
        );
        processed++;
        console.log(`[worker] ${claimed.orderNumber} -> needs_review (emergency mode)`);
      } catch (err) {
        console.error(`[worker] Order ${claimed.orderNumber} threw while holding for manual fulfillment: ${String(err)}`);
        await alerter.send('critical', 'Could not hold order for manual fulfillment', {
          orderNumber: claimed.orderNumber,
          error: String(err),
        });
      }
      continue;
    }

    try {
      const result = await orderBoundary.withLock(ORDER_BOUNDARY_KEY, () =>
        fulfillOrder(
          {
            store,
            providers,
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

export interface ItemFulfillmentRunnerDeps {
  queue: { claimNext(staleAfterMs: number): Promise<{ id: string; orderNumber: string; recovered: boolean } | null> };
  store: ItemFulfillmentStore;
  client: RocketPassOrderClient;
  alerter: Alerter;
  config: { maxAttempts: number; staleOrderMs: number; idlePollMs: number };
}

/**
 * RocketPass's own equivalent of `runFulfillmentLoop` — claim and place item
 * orders until asked to stop. Deliberately not sharing a lock/boundary with
 * the diamond loop above: RocketPass orders don't touch the diamond wallet
 * or any other mutable state the two loops could race over, and emergency
 * mode (about RA/Central One's own health) has nothing to do with RocketPass
 * being up or down.
 */
export async function runItemFulfillmentLoop(
  deps: ItemFulfillmentRunnerDeps,
  signal: ShutdownSignal,
  options: { maxIterations?: number } = {},
): Promise<{ processed: number }> {
  const { queue, store, client, alerter, config } = deps;
  let processed = 0;
  let iterations = 0;

  while (!signal.requested) {
    if (options.maxIterations !== undefined && iterations >= options.maxIterations) break;
    iterations++;

    let claimed;
    try {
      claimed = await queue.claimNext(config.staleOrderMs);
    } catch (err) {
      console.error(`[worker] Could not claim an item order: ${String(err)}`);
      await sleep(config.idlePollMs);
      continue;
    }

    if (!claimed) {
      await sleep(config.idlePollMs);
      continue;
    }

    if (claimed.recovered) {
      console.warn(`[worker] Recovered abandoned item order ${claimed.orderNumber}`);
    }

    try {
      const outcome = await fulfillItemOrder(
        { store, client, alerter, config: { maxAttempts: config.maxAttempts } },
        claimed.id,
      );
      processed++;
      console.log(
        outcome.kind === 'applied'
          ? `[worker] item ${claimed.orderNumber} -> ${outcome.decision.itemStatus}`
          : `[worker] item ${claimed.orderNumber} already placed with RocketPass — leaving for the poller/webhook`,
      );
    } catch (err) {
      // Stays `processing`; the staleness window brings it back — same
      // reasoning as the diamond loop above.
      console.error(`[worker] Item order ${claimed.orderNumber} threw: ${String(err)}`);
      await alerter.send('critical', 'Item fulfilment threw an unexpected error', {
        orderNumber: claimed.orderNumber,
        error: String(err),
      });
    }
  }

  return { processed };
}

/** Poll PENDING orders, recover dead-worker items, watch the wallet. */
export async function runSweepOnce(deps: RunnerDeps): Promise<void> {
  const { store, providers, lock, alerter, config, isEmergencyMode } = deps;
  const pollerDeps = {
    store,
    providers,
    lock,
    alerter,
    isEmergencyMode,
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
  const { providers, alerter, queue, config } = deps;
  // Only RA has a configured threshold today — Central One's wallet still
  // gets checked (so a bad reading fails loudly) but never alerts on being
  // "low", since there is no equivalent business threshold for it yet.
  const thresholdUsd: Partial<Record<ProviderName, number>> = {
    recargas_america: config.provider.lowBalanceUsd,
  };

  for (const providerName of PROVIDER_NAMES) {
    try {
      const balance = await providers[providerName].getBalance();
      const threshold = thresholdUsd[providerName];
      if (threshold === undefined) continue;

      if (balance < (Math.round(threshold * 10_000) as UsdTenK)) {
        const depth = await queue.depth().catch(() => ({}));
        await alerter.send('critical', 'Provider wallet is low', {
          provider: providerName,
          balanceUsd: (balance / 10_000).toFixed(2),
          thresholdUsd: threshold,
          outstandingOrders: JSON.stringify(depth),
        });
      }
    } catch (err) {
      console.error(`[sweep] Could not read ${providerName} wallet balance: ${String(err)}`);
    }
  }
}

/** One sync result per provider — both are synced on the same schedule, independently. */
export type CatalogSyncRunResult = Record<ProviderName, CatalogSyncResult | null>;

/**
 * Both providers' catalog syncs, as the worker runs them.
 *
 * Before this ran on its own the sync was a CLI someone had to remember, so a
 * provider changing its ids would have surfaced as customers complaining that
 * nothing could be bought. Now the worker notices within the hour and either
 * follows the change (re-pointing recipes and unsent items) or says loudly that
 * it could not.
 *
 * Both providers are synced every time, independently — Central One stays
 * ready to fail over to even while RecargasAmérica is primary, so activating
 * it never needs a live Central One call at the stressful moment of an actual
 * outage. Each provider's sync is still scoped to its own rows (see
 * `CatalogSyncStore`), so one can never deactivate or re-point the other's.
 *
 * Lock order is the same as fulfilment's — order boundary, then the
 * provider's own lock — so the two cannot deadlock. Each provider's lock is
 * what guarantees no item of ITS is re-pointed while its own call is in
 * flight; see `ORDER_BOUNDARY_KEY` for why the boundary is needed on top.
 *
 * A provider whose sync throws gets `null` in the result. Like every sweep
 * step, a failure is logged and survived — a bad minute on one provider's
 * catalog endpoint must not stop the worker delivering orders already paid
 * for, nor stop the OTHER provider's sync from running.
 */
export async function runCatalogSync(deps: RunnerDeps): Promise<CatalogSyncRunResult> {
  const { catalog, providers, lock, orderBoundary, alerter } = deps;

  // The `Alerter` contract is never to throw, but this runs on the sweep loop
  // and a broken alerter must not be what stops it.
  const send: Alerter['send'] = (level, title, detail) =>
    alerter.send(level, title, detail).catch((err: unknown) => {
      console.error(`[catalog] Could not send alert "${title}": ${String(err)}`);
    });

  const results = {} as CatalogSyncRunResult;

  for (const providerName of PROVIDER_NAMES) {
    try {
      const result = await orderBoundary.withLock(ORDER_BOUNDARY_KEY, () =>
        lock.withLock(PROVIDER_LOCK_KEYS[providerName], () =>
          syncCatalog({ store: catalog, provider: providers[providerName], providerName }),
        ),
      );
      results[providerName] = result;

      const alerts = catalogSyncAlerts(result);
      const line = `[catalog] ${providerName}: ${summariseSync(result)}`;
      if (alerts.length > 0) console.warn(line);
      else console.log(line);
      for (const alert of alerts) {
        await send(alert.level, `${alert.title} (${providerName})`, alert.detail);
      }
    } catch (err) {
      console.error(`[catalog] Sync failed for ${providerName}: ${String(err)}`);
      // Warn, not critical: a failed sync changes nothing — the previous
      // catalog stays exactly as it was — and the retry comes round shortly.
      // If the provider's purchase endpoints are down too, fulfilment says so
      // itself.
      await send('warn', `Provider catalog sync failed — will retry (${providerName})`, {
        error: String(err),
      });
      results[providerName] = null;
    }
  }

  return results;
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
  ): Promise<{ ran: boolean; result: CatalogSyncRunResult | null }> {
    if (!this.isDue(now)) return { ran: false, result: null };

    const result = await runCatalogSync(deps);
    // Scheduled from when the run was due, not when it finished, and sooner
    // if either provider's sync failed: on the day a provider migrates, an
    // hour between attempts is an hour of not knowing.
    const anyFailed = Object.values(result).some((r) => r === null);
    this.nextAt = now + (anyFailed ? Math.min(this.intervalMs, this.retryMs) : this.intervalMs);
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
 * Warn a customer their payment window is about to close. Same "separate
 * optional dep bundle" shape as `runConversions`/`runSeasonClose` — a failure
 * here must never hold up a delivery, and this touches nothing fulfilment
 * needs.
 */
export async function runExpiryReminders(deps: ExpiryReminderDeps): Promise<ExpiryReminderResult | null> {
  try {
    const result = await sendExpiryReminders(deps);
    if (result.examined > 0) {
      console.log(`[expiry-reminders] reminded ${result.reminded}, ${result.failed} failed`);
    }
    return result;
  } catch (err) {
    console.error(`[expiry-reminders] Sweep failed: ${String(err)}`);
    return null;
  }
}

/**
 * RocketPass catalog/stock sync. Same "separate optional dep bundle" shape as
 * `runConversions` — called every sweep tick rather than on its own longer
 * schedule like the diamond catalog sync: RocketPass's own docs warn against
 * caching stock more than a few minutes, and one call every 30s is nowhere
 * near its 60/min rate limit.
 */
export async function runRocketPassSync(deps: RocketPassSyncDeps): Promise<RocketPassSyncResult | null> {
  try {
    const result = await syncRocketPassCatalog(deps);
    if (result.synced > 0 || result.skipped > 0) {
      console.log(`[rocketpass] synced ${result.synced} item(s), skipped ${result.skipped} (level_pass)`);
    }
    return result;
  } catch (err) {
    console.error(`[rocketpass] Catalog sync failed: ${String(err)}`);
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

/**
 * Golden Tickets giveaways (Module 2): close any giveaway past its
 * `closesAt`. If it met its minimum AND already has a prize value set, the
 * winner(s) are drawn right here, automatically — no admin click needed
 * (per the client's request to stop waiting on a manual draw). If it met
 * its minimum but has no prize value yet, it falls back to
 * `closed_pending_draw` for a manual draw once that's set. Below the
 * minimum, it's `cancelled` with every entrant refunded. Every giveaway has
 * its own due time (a row query, not a single global timer), so this rides
 * the plain sweep cadence like `runLevelPassSync`/`runSeasonClose` rather
 * than needing a `CatalogSyncSchedule`-style schedule of its own.
 */
export async function runGiveawayDraws(deps: {
  store: Pick<DrizzleGiveawayAdminStore, 'closeDueGiveaways'>;
}): Promise<{ closedPendingDraw: number; autoDrawn: number; cancelledAndRefunded: number } | null> {
  try {
    const result = await deps.store.closeDueGiveaways(new Date());
    if (result.closedPendingDraw > 0 || result.autoDrawn > 0 || result.cancelledAndRefunded > 0) {
      console.log(
        `[giveaways] ${result.autoDrawn} auto-drawn, ${result.closedPendingDraw} closed awaiting a manual draw (no prize value set), ${result.cancelledAndRefunded} cancelled and refunded`,
      );
    }
    return result;
  } catch (err) {
    console.error(`[giveaways] Sweep failed: ${String(err)}`);
    return null;
  }
}

/**
 * The scheduling feature the client asked for: a draft giveaway saved with a
 * future `opensAt` publishes itself once that time arrives — no admin click
 * needed. Admin still creates every giveaway by hand (nothing here generates
 * new ones), this only flips the one manual "Publicar" step into a schedule.
 */
export async function runGiveawayAutoPublish(deps: {
  store: Pick<DrizzleGiveawayAdminStore, 'autoPublishDue'>;
}): Promise<number | null> {
  try {
    const count = await deps.store.autoPublishDue(new Date());
    if (count > 0) console.log(`[giveaways] ${count} draft(s) auto-published on schedule`);
    return count;
  } catch (err) {
    console.error(`[giveaways] Auto-publish sweep failed: ${String(err)}`);
    return null;
  }
}

/**
 * Automatic delivery for `prizeType = 'diamonds'` giveaway winners, in two
 * halves — same shape as `runRewardDelivery` above, and for the same reason:
 * turn a winner into a real `$0` order (which `runFulfillmentLoop`/the
 * poller then deliver like any other order), then close the loop for
 * whichever of those orders has since completed. `prizeType = 'manual'`
 * winners never appear here — those stay the admin's own
 * `markWinnerDelivered` click.
 */
export async function runGiveawayPrizeDelivery(
  deps: { store: GiveawayPrizeDeliveryStore },
  batchSize: number,
): Promise<void> {
  try {
    const created = await createPendingGiveawayPrizeOrders(deps, batchSize);
    if (created.examined > 0) {
      console.log(
        `[giveaway-prizes] ${created.created} order(s) created, ${created.unresolved} unresolved, ${created.failed} failed`,
      );
    }
  } catch (err) {
    console.error(`[giveaway-prizes] Could not create pending prize orders: ${String(err)}`);
  }

  try {
    const granted = await grantCompletedGiveawayPrizes(deps, batchSize);
    if (granted.examined > 0) {
      console.log(`[giveaway-prizes] ${granted.granted} granted, ${granted.failed} failed`);
    }
  } catch (err) {
    console.error(`[giveaway-prizes] Could not grant completed prize orders: ${String(err)}`);
  }
}
