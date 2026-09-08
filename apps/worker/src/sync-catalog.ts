/**
 * Catalog sync CLI.
 *
 * Run after Phase 0 resolves the provider's real product IDs, and on a schedule
 * afterwards — supplier prices move without notice, and revenue is fixed in MXN
 * by a flyer for a whole month.
 *
 *   pnpm --filter @levelup/worker sync-catalog
 *   WORKER_DRY_RUN=true pnpm --filter @levelup/worker sync-catalog
 */

import { createDb, DrizzleCatalogSyncStore } from '@levelup/db';
import { summariseSync, syncCatalog } from '@levelup/engine';
import { ProviderSimulator, RecargasAmericaProvider } from '@levelup/provider';
import { ConsoleAlerter, TelegramAlerter } from './alerter.js';

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

try {
  console.log(`Syncing provider catalog${dryRun ? ' (DRY RUN — simulated provider)' : ''}\n`);

  const result = await syncCatalog({ store, provider });
  console.log(summariseSync(result));

  if (result.added.length) console.log(`\n  added:       ${result.added.join(', ')}`);
  if (result.deactivated.length) console.log(`  deactivated: ${result.deactivated.join(', ')}`);

  if (result.skipped.length) {
    console.log('\n  Skipped:');
    for (const s of result.skipped) console.log(`    ${s.providerProductId} — ${s.reason}`);
  }

  // A cost rise silently eats a whole month of margin, so this is an alert and
  // not just a log line.
  if (result.costChanges.length) {
    console.log('\n  Cost changes:');
    for (const change of result.costChanges) {
      const direction = change.deltaUsd > 0 ? 'up' : 'down';
      console.log(
        `    ${change.diamondsBase} 💎  ${(change.previousUsd / 10_000).toFixed(4)} -> ` +
          `${(change.currentUsd / 10_000).toFixed(4)} USD  (${direction} ${change.pctChange.toFixed(1)}%)`,
      );
    }
    await alerter.send('warn', 'Provider costs changed — re-check combo margins', {
      changes: result.costChanges
        .map((c) => `${c.diamondsBase}: ${c.pctChange.toFixed(1)}%`)
        .join(', '),
    });
  }

  if (result.blocked) {
    console.error('\nBLOCKED — no denomination resolved to a direct top-up.');
    await alerter.send('critical', 'Catalog sync found no usable Free Fire products', {});
    process.exitCode = 1;
  } else if (result.missing.length) {
    console.warn(`\nWARNING — no product for: ${result.missing.join(', ')}`);
    console.warn('Combos using these denominations cannot be fulfilled.');
    await alerter.send('critical', 'Catalog sync is missing denominations', {
      missing: result.missing.join(', '),
    });
  }

  const incomplete = await store.findIncompleteRecipes();
  if (incomplete.length) {
    console.warn(`\n${incomplete.length} combo(s) still have no recipe:`);
    for (const combo of incomplete) console.warn(`    ${combo.comboKey} — ${combo.name}`);
    console.warn('\nRun `pnpm db:seed` to build recipes now that products exist.');
  }
} finally {
  await client.end({ timeout: 10 });
}
