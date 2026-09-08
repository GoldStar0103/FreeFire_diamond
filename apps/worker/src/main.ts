/**
 * Fulfilment worker entrypoint.
 *
 * Runs two things concurrently: the order loop and a periodic sweep. Both share
 * one advisory lock, so a sweep never runs while a combo is mid-flight.
 *
 *   node --experimental-strip-types apps/worker/src/main.ts
 */

import {
  createDb,
  DrizzleOrderQueue,
  DrizzleRecoveryStore,
  PostgresAdvisoryLock,
} from '@levelup/db';
import { RecargasAmericaProvider, ProviderSimulator } from '@levelup/provider';
import { ConsoleAlerter, TelegramAlerter } from './alerter.js';
import { loadConfig } from './config.js';
import { runFulfillmentLoop, runSweepOnce, ShutdownSignal, type RunnerDeps } from './runner.js';

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
    provider,
    lock: new PostgresAdvisoryLock(client),
    alerter,
    config,
  };

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
      `poll ${config.fulfillment.idlePollMs}ms, sweep ${config.sweeps.intervalMs}ms`,
  );

  const sweeps = (async () => {
    while (!signal.requested) {
      await runSweepOnce(deps);
      // Short slices so shutdown is not held up by a long sweep interval.
      const until = Date.now() + config.sweeps.intervalMs;
      while (Date.now() < until && !signal.requested) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  })();

  const { processed } = await runFulfillmentLoop(deps, signal);
  await sweeps;

  console.log(`[worker] Stopped after processing ${processed} order(s)`);
  await client.end({ timeout: 10 });
}

main().catch(async (err) => {
  console.error('[worker] Fatal:', err);
  process.exitCode = 1;
});
