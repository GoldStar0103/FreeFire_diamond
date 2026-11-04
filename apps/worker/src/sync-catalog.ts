/**
 * Catalog sync CLI.
 *
 * The worker runs the same sync on its own — at startup and every
 * CATALOG_SYNC_INTERVAL_MS, for every configured provider — so this is for
 * running it *now*: after Phase 0 resolves a provider's real product IDs, or
 * on the day a provider says it is changing its catalog, when waiting up to
 * an hour is not good enough.
 *
 * Safe to run while the worker is up. It takes the same per-provider advisory
 * lock fulfilment does, so nothing is re-pointed while a provider call is in
 * flight. The reporting and alerting are the worker's, from
 * `catalog-report.ts`, so the two can never disagree about what a result means.
 *
 *   pnpm --filter @levelup/worker sync-catalog
 *   WORKER_DRY_RUN=true pnpm --filter @levelup/worker sync-catalog
 *
 * Do not run the dry-run form against a real database: the simulator's catalog
 * has its own ids, and the sync would faithfully treat that as the provider
 * replacing every product.
 *
 * Syncs RecargasAmérica always, and Central One too when `CENTRALONE_API_KEY`
 * is set (or always, in dry run) — matching exactly which providers the
 * worker itself keeps synced in the background.
 */

import { createDb, DrizzleCatalogSyncStore, PostgresAdvisoryLock } from '@levelup/db';
import { PROVIDER_LOCK_KEYS, summariseSync, syncCatalog } from '@levelup/engine';
import {
  CentralOneProvider,
  ProviderSimulator,
  RecargasAmericaProvider,
  type ProviderName,
  type TopupProvider,
} from '@levelup/provider';
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

const providers: Partial<Record<ProviderName, TopupProvider>> = {
  recargas_america: dryRun
    ? new ProviderSimulator({ defaultPriceUsd: 10 })
    : new RecargasAmericaProvider({
        baseUrl: process.env.RA_BASE_URL ?? 'https://panel.recargasamerica.com/api/v1',
        apiKey: apiKey!,
      }),
};

if (dryRun) {
  providers.central_one = new ProviderSimulator({ defaultPriceUsd: 10 });
} else if (process.env.CENTRALONE_API_KEY) {
  providers.central_one = new CentralOneProvider({
    baseUrl: process.env.CENTRALONE_BASE_URL ?? 'https://portal.centraloneglobal.com/api/v1',
    apiKey: process.env.CENTRALONE_API_KEY,
  });
}

const store = new DrizzleCatalogSyncStore(db);
const lock = new PostgresAdvisoryLock(client);

try {
  let anyBlocked = false;

  for (const [providerName, provider] of Object.entries(providers) as Array<[ProviderName, TopupProvider]>) {
    console.log(
      `Syncing ${providerName} catalog${dryRun ? ' (DRY RUN — simulated provider)' : ''}\n`,
    );

    const result = await lock.withLock(PROVIDER_LOCK_KEYS[providerName], () =>
      syncCatalog({ store, provider, providerName }),
    );

    console.log(summariseSync(result));
    const details = describeSync(result);
    if (details.length) console.log(['', ...details].join('\n'));

    for (const alert of catalogSyncAlerts(result)) {
      await alerter.send(alert.level, `${alert.title} (${providerName})`, alert.detail);
    }

    // Non-zero for anything a human must look at before trusting the store.
    if (result.blocked || result.denominationConflicts.length) anyBlocked = true;
    console.log('');
  }

  if (anyBlocked) process.exitCode = 1;

  const incomplete = await store.findIncompleteRecipes();
  if (incomplete.length) {
    console.warn(`\n${incomplete.length} combo(s) still have no recipe:`);
    for (const combo of incomplete) console.warn(`    ${combo.comboKey} — ${combo.name}`);
    console.warn('\nRun `pnpm db:seed` to build recipes now that products exist.');
  }
} finally {
  await client.end({ timeout: 10 });
}
