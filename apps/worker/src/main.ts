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
  PostgresAdvisoryLock,
} from '@levelup/db';
import { InMemoryLock } from '@levelup/engine';
import { RecargasAmericaProvider, ProviderSimulator } from '@levelup/provider';
import { ConsoleAlerter, TelegramAlerter } from './alerter.js';
import { loadConfig } from './config.js';
import { startHeartbeat } from './heartbeat.js';
import { MetaConversionsReporter } from './meta-capi.js';
import {
  CatalogSyncSchedule,
  runConversions,
  runFulfillmentLoop,
  runLevelPassSync,
  runSeasonClose,
  runSweepOnce,
  ShutdownSignal,
  type RunnerDeps,
} from './runner.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, client } = createDb(config.databaseUrl);

  const alerter = config.telegram ? new TelegramAlerter(config.telegram) : new ConsoleAlerter();

  const provider = config.dryRun
    ? new ProviderSimulator({ initialBalanceUsd: 500 })
    : new RecargasAmericaProvider({
        baseUrl: config.provider.baseUrl,
        apiKey: config.provider.apiKey,
      });

  const deps: RunnerDeps = {
    queue: new DrizzleOrderQueue(db),
    store: new DrizzleRecoveryStore(db),
    catalog: new DrizzleCatalogSyncStore(db),
    provider,
    lock: new PostgresAdvisoryLock(client),
    // In-process on purpose: it only has to separate this worker's own order
    // loop from its own catalog sync. Across processes the advisory lock rules.
    orderBoundary: new InMemoryLock(),
    alerter,
    config,
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
