/**
 * Catalog sync CLI.
 *
 * The worker runs the same sync on its own — at startup and every
 * CATALOG_SYNC_INTERVAL_MS — so this is for running it *now*: after Phase 0
 * resolves the provider's real product IDs, or on the day the provider says it
 * is changing its catalog, when waiting up to an hour is not good enough.
 *
 * Safe to run while the worker is up. It takes the same provider advisory lock
 * fulfilment does, so nothing is re-pointed while a provider call is in flight.
 * The reporting and alerting are the worker's, from `catalog-report.ts`, so the
 * two can never disagree about what a result means.
 *
 *   pnpm --filter @levelup/worker sync-catalog
 *   WORKER_DRY_RUN=true pnpm --filter @levelup/worker sync-catalog
 *
 * Do not run the dry-run form against a real database: the simulator's catalog
 * has its own ids, and the sync would faithfully treat that as the provider
 * replacing every product.
 */

import { createDb, DrizzleCatalogSyncStore, PostgresAdvisoryLock } from '@levelup/db';
import { PROVIDER_LOCK_KEY, summariseSync, syncCatalog } from '@levelup/engine';
import { ProviderSimulator, RecargasAmericaProvider } from '@levelup/provider';
import { ConsoleAlerter, TelegramAlerter } from './alerter.js';
import { catalogSyncAlerts, describeSync } from './catalog-report.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const dryRun = process.env.WORKER_DRY_RUN === 'true';
const apiKey = process.env.RA_API_KEY;
if (!dryRun && !apiKey) {
  throw new Error('RA_API_KEY is required (or set WORKER_DRY_RUN=true to use the simulator)');
}

const { db, client } = createDb(databaseUrl);

const alerter =
  process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALERT_CHAT_ID
    ? new TelegramAlerter({
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_ALERT_CHAT_ID,
      })
    : new ConsoleAlerter();

const provider = dryRun
  ? new ProviderSimulator({ defaultPriceUsd: 10 })
  : new RecargasAmericaProvider({
      baseUrl: process.env.RA_BASE_URL ?? 'https://panel.recargasamerica.com/api/v1',
      apiKey: apiKey!,
    });

const store = new DrizzleCatalogSyncStore(db);
const lock = new PostgresAdvisoryLock(client);

try {
  console.log(`Syncing provider catalog${dryRun ? ' (DRY RUN — simulated provider)' : ''}\n`);

  const result = await lock.withLock(PROVIDER_LOCK_KEY, () => syncCatalog({ store, provider }));

  console.log(summariseSync(result));
  const details = describeSync(result);
  if (details.length) console.log(['', ...details].join('\n'));

  for (const alert of catalogSyncAlerts(result)) {
    await alerter.send(alert.level, alert.title, alert.detail);
  }

  // Non-zero for anything a human must look at before trusting the store.
  if (result.blocked || result.denominationConflicts.length) process.exitCode = 1;

  const incomplete = await store.findIncompleteRecipes();
  if (incomplete.length) {
    console.warn(`\n${incomplete.length} combo(s) still have no recipe:`);
    for (const combo of incomplete) console.warn(`    ${combo.comboKey} — ${combo.name}`);
    console.warn('\nRun `pnpm db:seed` to build recipes now that products exist.');
  }
} finally {
  await client.end({ timeout: 10 });
}
