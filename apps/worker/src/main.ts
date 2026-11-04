/**
 * Fulfilment worker entrypoint.
 *
 * Runs two things concurrently: the order loop and a periodic sweep. Both share
 * one advisory lock, so a sweep never runs while a combo is mid-flight. The
 * sweep loop also carries the provider catalog sync — once at startup, then
 * every CATALOG_SYNC_INTERVAL_MS.
 *
 *   node --experimental-strip-types apps/worker/src/main.ts
 */

import {
  createDb,
  DrizzleCatalogSyncStore,
  DrizzleConversionStore,
  DrizzleLevelPassStore,
  DrizzleOrderQueue,
  DrizzleRecoveryStore,
  DrizzleSeasonStore,
  getEmergencyMode,
  PostgresAdvisoryLock,
  saveEmergencyMode,
  setActiveProvider as setActiveProviderSetting,
  type Database,
} from '@levelup/db';
import { activateProvider, InMemoryLock, type Alerter, type CatalogSyncStore } from '@levelup/engine';
import {
  CentralOneProvider,
  RecargasAmericaProvider,
  ProviderSimulator,
  wrapWithHealthMonitor,
  type ProviderHealthTrigger,
  type ProviderName,
  type TopupProvider,
  type UsdTenK,
} from '@levelup/provider';
import { ConsoleAlerter, TelegramAlerter } from './alerter.js';
import { loadConfig } from './config.js';
import { startHeartbeat } from './heartbeat.js';
import { MetaConversionsReporter } from './meta-capi.js';
import {
  CatalogSyncSchedule,
  runConversions,
  runFulfillmentLoop,
  runLevelPassSync,
  runRewardDelivery,
  runSeasonClose,
  runSweepOnce,
  ShutdownSignal,
  type RunnerDeps,
} from './runner.js';

const PROVIDER_LABEL: Record<ProviderName, string> = {
  recargas_america: 'RecargasAmérica',
  central_one: 'Central One',
};

function describeTrigger(provider: ProviderName, trigger: ProviderHealthTrigger): string {
  const label = PROVIDER_LABEL[provider];
  switch (trigger.reason) {
    case 'maintenance_detected':
      return `${label} reported itself under maintenance`;
    case 'wallet_unreadable':
      return `Could not read the ${label} wallet balance`;
    case 'consecutive_api_errors':
      return `${label} returned repeated API errors`;
  }
}

/**
 * The last resort: park orders for manual fulfillment, same as Jose flipping
 * the toggle himself in Ajustes. Idempotent — does nothing (and says nothing)
 * if emergency mode is already on, so a second provider failing while the
 * first is still being handled by hand does not spam a second alert.
 *
 * `adminUserId: null` marks the audit entry as system-triggered, the same
 * convention the emergency-mode tests use for actions with no human admin
 * behind them.
 */
async function fallBackToEmergencyMode(
  db: Database,
  alerter: Alerter,
  provider: ProviderName,
  trigger: ProviderHealthTrigger,
): Promise<void> {
  const current = await getEmergencyMode(db);
  if (current.enabled) return; // already held — nothing new to do or say

  await saveEmergencyMode(db, { enabled: true }, null);
  await alerter.send(
    'critical',
    `Emergency mode activated automatically — ${describeTrigger(provider, trigger)}`,
    { provider, reason: trigger.reason, detail: trigger.message },
  );
}

/**
 * Fires when `wrapWithHealthMonitor` sees RecargasAmérica misbehave, per
 * Jose's own 3 trigger conditions (2026-11-03). Tries the real middle tier
 * first — switching to Central One, reusing whatever it last synced in the
 * background — and only falls back to manual-hold emergency mode if Central
 * One is not actually serving anything (not ready, or the switch itself
 * errors). `activateProvider` sends its own alert on a real or partial
 * switch, so this only alerts again when nothing is on Central One at all.
 *
 * `checkWallet` reads RA's balance every sweep regardless of which provider
 * is active (so the dashboard tile stays current), so this fires repeatedly
 * for as long as RA stays down — every single time must correctly recognise
 * "Central One is already active, nothing to do" as success. Checking only
 * `switched.length` got this wrong: once nothing was LEFT to switch (already
 * fully on Central One), it fell through to emergency mode on every one of
 * those repeats, overriding any manual "off" within the next sweep.
 */
async function handleRaHealthTrigger(
  db: Database,
  catalogStore: CatalogSyncStore,
  alerter: Alerter,
  trigger: ProviderHealthTrigger,
): Promise<void> {
  console.error(`[worker] RecargasAmérica health trigger '${trigger.reason}': ${trigger.message}`);

  try {
    const result = await activateProvider(
      {
        store: catalogStore,
        alerter,
        setActiveProvider: (provider, adminUserId) => setActiveProviderSetting(db, provider, adminUserId),
      },
      'central_one',
    );
    // Central One is serving at least something — whether this call just
    // switched it there or it already was. Only a complete failure (nothing
    // switched, nothing already active) falls through below.
    if (result.switched.length > 0 || result.alreadyActive.length > 0) return;
  } catch (err) {
    console.error(`[worker] Could not switch to Central One: ${String(err)}`);
  }

  await fallBackToEmergencyMode(db, alerter, 'recargas_america', trigger);
}

/**
 * Fires when Central One itself misbehaves — only relevant once it is the
 * active provider. Deliberately does NOT try to switch back to RA
 * automatically: two providers taking turns failing would otherwise flap
 * between them. Switching back is a manual admin action, same as turning
 * emergency mode off once Jose has confirmed RA recovered.
 */
async function handleCentralOneHealthTrigger(
  db: Database,
  alerter: Alerter,
  trigger: ProviderHealthTrigger,
): Promise<void> {
  console.error(`[worker] Central One health trigger '${trigger.reason}': ${trigger.message}`);
  await fallBackToEmergencyMode(db, alerter, 'central_one', trigger);
}

/**
 * Stands in for Central One when `CENTRALONE_API_KEY` is not set. Every
 * money-moving call fails loudly rather than being silently unavailable —
 * `listFreeFireCatalog` alone returns empty, so the background sync reports
 * an honest "0/6 mapped" rather than throwing, and `activateProvider` can
 * never find a ready candidate to switch to.
 */
class UnconfiguredProvider implements TopupProvider {
  async listFreeFireCatalog() {
    return [];
  }
  async getBalance(): Promise<UsdTenK> {
    throw new Error('Central One is not configured (CENTRALONE_API_KEY unset)');
  }
  async validatePlayer(): Promise<never> {
    throw new Error('Central One is not configured (CENTRALONE_API_KEY unset)');
  }
  async purchase(): Promise<never> {
    throw new Error('Central One is not configured (CENTRALONE_API_KEY unset)');
  }
  async getOrderStatus() {
    return null;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, client } = createDb(config.databaseUrl);

  const alerter = config.telegram ? new TelegramAlerter(config.telegram) : new ConsoleAlerter();
  const catalogStore = new DrizzleCatalogSyncStore(db);

  const rawRaProvider = config.dryRun
    ? new ProviderSimulator({ initialBalanceUsd: 500 })
    : new RecargasAmericaProvider({
        baseUrl: config.provider.baseUrl,
        apiKey: config.provider.apiKey,
      });

  const rawCentralOneProvider: TopupProvider = config.dryRun
    ? new ProviderSimulator({ initialBalanceUsd: 500 })
    : config.centralOne
      ? new CentralOneProvider({
          baseUrl: config.centralOne.baseUrl,
          apiKey: config.centralOne.apiKey,
        })
      : new UnconfiguredProvider();

  // Jose's own trigger conditions for activating a backup provider
  // (2026-11-03): RA announcing maintenance, the wallet becoming unreadable,
  // or three orders in a row coming back with no clean response. Both
  // providers are watched the same way, each cascading differently on
  // trigger — see `handleRaHealthTrigger`/`handleCentralOneHealthTrigger`.
  const providers: Record<ProviderName, TopupProvider> = {
    recargas_america: wrapWithHealthMonitor(rawRaProvider, (trigger) =>
      handleRaHealthTrigger(db, catalogStore, alerter, trigger),
    ),
    central_one: wrapWithHealthMonitor(rawCentralOneProvider, (trigger) =>
      handleCentralOneHealthTrigger(db, alerter, trigger),
    ),
  };

  const deps: RunnerDeps = {
    queue: new DrizzleOrderQueue(db),
    store: new DrizzleRecoveryStore(db),
    catalog: catalogStore,
    providers,
    lock: new PostgresAdvisoryLock(client),
    // In-process on purpose: it only has to separate this worker's own order
    // loop from its own catalog sync. Across processes the advisory lock rules.
    orderBoundary: new InMemoryLock(),
    alerter,
    config,
    isEmergencyMode: async () => (await getEmergencyMode(db)).enabled,
  };

  const catalogSchedule = new CatalogSyncSchedule(config.catalogSync.intervalMs);

  const levelPassStore = new DrizzleLevelPassStore(db);
  const seasonStore = new DrizzleSeasonStore(db);

  // Server-side purchase reporting for the ad account. Off without a token.
  const conversions = config.meta
    ? {
        store: new DrizzleConversionStore(db),
        reporter: new MetaConversionsReporter(config.meta),
        alerter,
      }
    : null;

  const signal = new ShutdownSignal();

  // SIGTERM stops us claiming new work; the combo in flight finishes first.
  // Killing mid-combo would leave a paid customer partially delivered.
  let shuttingDown = false;
  for (const event of ['SIGTERM', 'SIGINT'] as const) {
    process.on(event, () => {
      if (shuttingDown) {
        console.warn('[worker] Second signal — exiting immediately');
        process.exit(1);
      }
      shuttingDown = true;
      console.log(`[worker] ${event} received; finishing the current order`);
      signal.stop();
    });
  }

  console.log(
    `[worker] Starting${config.dryRun ? ' (DRY RUN — simulated provider)' : ''}, ` +
      `poll ${config.fulfillment.idlePollMs}ms, sweep ${config.sweeps.intervalMs}ms, ` +
      `catalog sync ${catalogSchedule.enabled ? `${config.catalogSync.intervalMs}ms` : 'OFF'}, ` +
      `Meta CAPI ${conversions ? (config.meta?.testEventCode ? 'ON (TEST EVENTS)' : 'ON') : 'OFF'}`,
  );

  const heartbeat = startHeartbeat(config.heartbeatFile);

  // Before the first claim. A worker restarted after the provider changed its
  // catalog would otherwise dispatch its first orders to ids that no longer
  // exist. Failure is survived inside, and the sweep loop retries shortly.
  await catalogSchedule.runIfDue(deps);

  const sweeps = (async () => {
    while (!signal.requested) {
      await runSweepOnce(deps);
      await catalogSchedule.runIfDue(deps);
      if (conversions) await runConversions(conversions);
      await runLevelPassSync({
        store: levelPassStore,
        lookbackMs: config.levelPass.lookbackMs,
        batchSize: config.levelPass.batchSize,
      });
      // Reuses the same store instance — it also implements
      // `RewardFulfillmentStore`. Delivery itself happens through the
      // ordinary fulfilment loop above, not here.
      await runRewardDelivery({ store: levelPassStore }, config.levelPass.batchSize);
      await runSeasonClose({ store: seasonStore });
      // A beat per completed sweep, on top of the timer's. The timer proves the
      // event loop turns; this proves the sweep itself is still coming round.
      heartbeat.beat();
      // Short slices so shutdown is not held up by a long sweep interval.
      const until = Date.now() + config.sweeps.intervalMs;
      while (Date.now() < until && !signal.requested) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  })();

  try {
    const { processed } = await runFulfillmentLoop(deps, signal);
    await sweeps;
    console.log(`[worker] Stopped after processing ${processed} order(s)`);
  } finally {
    // Stop beating before the connection closes, so a crash cannot leave a
    // fresh heartbeat behind and keep the container marked healthy.
    heartbeat.stop();
    await client.end({ timeout: 10 });
  }
}

main().catch(async (err) => {
  console.error('[worker] Fatal:', err);
  process.exitCode = 1;
});
