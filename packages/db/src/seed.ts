/**
 * Seeds campaigns, combos and recipes from `phase0/catalog.mjs` — the same file
 * the Phase 0 audit reads, so the transcription of what the client actually
 * said has exactly one home.
 *
 * Base products are NOT seeded here. They mirror the provider catalog and are
 * populated by the Phase 0 sync once the API key resolves the real product IDs,
 * costs and endpoint path. Seeding guesses would defeat the point.
 *
 *   pnpm db:seed
 */

import { eq } from 'drizzle-orm';
import { pesosToCentavos, checkRecipe } from '@levelup/shared/money';
import { CAMPAIGNS } from '../../../phase0/catalog.mjs';
import { createDb } from './index.js';
import { campaigns, combos, comboItems, baseProducts, settings } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

const { db, client } = createDb(DATABASE_URL);

/** Only the Mega Oferta is capped — the flyer says "válido solo para clientes nuevos". */
const perPlayerCap = (comboKey: string) => (comboKey === 'mega_10' ? 1 : null);

/**
 * `.returning()` is typed as an array, so under `noUncheckedIndexedAccess` the
 * first element is `T | undefined`. An upsert that returns nothing means the
 * write silently did not happen — fail loudly rather than carry an undefined
 * foreign key into the next insert.
 */
function requireOne<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Expected ${what} to be returned by the upsert, got nothing`);
  return row;
}

async function seed() {
  console.log('Seeding catalog from phase0/catalog.mjs\n');

  let campaignCount = 0;
  let comboCount = 0;
  let itemCount = 0;
  let skippedRecipes = 0;
  const shortfalls: string[] = [];

  for (const [campaignIndex, campaign] of CAMPAIGNS.entries()) {
    const campaignRow = requireOne(
      await db
      .insert(campaigns)
      .values({
        key: campaign.key,
        name: campaign.name,
        permanent: campaign.permanent,
        sortOrder: campaignIndex,
        active: true,
      })
      .onConflictDoUpdate({
        target: campaigns.key,
        set: { name: campaign.name, permanent: campaign.permanent, sortOrder: campaignIndex },
      })
        .returning(),
      `campaign ${campaign.key}`,
    );

    campaignCount++;
    console.log(`  ${campaign.name}`);

    for (const [comboIndex, combo] of campaign.combos.entries()) {
      // A combo that delivers less than it advertises is a defect, not data.
      // Seed it anyway so the client sees it in the panel, but say so loudly —
      // the publish validator will refuse to make it live.
      const { delivered, gap, ok } = checkRecipe(combo.advertised, combo.recipe);
      if (!ok) shortfalls.push(`${combo.name}: advertises ${combo.advertised}, delivers ${delivered} (${gap})`);

      const comboRow = requireOne(
        await db
        .insert(combos)
        .values({
          campaignId: campaignRow.id,
          key: combo.key,
          name: combo.name,
          priceMxnCents: pesosToCentavos(combo.priceMxn),
          advertisedDiamonds: combo.advertised,
          maxPerPlayer: perPlayerCap(combo.key),
          sortOrder: comboIndex,
          active: ok,
        })
        .onConflictDoUpdate({
          target: combos.key,
          set: {
            name: combo.name,
            priceMxnCents: pesosToCentavos(combo.priceMxn),
            advertisedDiamonds: combo.advertised,
            sortOrder: comboIndex,
          },
        })
          .returning(),
        `combo ${combo.key}`,
      );

      comboCount++;

      // Recipes reference base_products, which only exist after the provider
      // sync. Link them when the denomination is already known; otherwise skip
      // and re-run this seed after Phase 0.
      await db.delete(comboItems).where(eq(comboItems.comboId, comboRow.id));

      for (const [sequence, denomination] of combo.recipe.entries()) {
        const [product] = await db
          .select({ id: baseProducts.id })
          .from(baseProducts)
          .where(eq(baseProducts.diamondsBase, denomination))
          .limit(1);

        if (!product) {
          skippedRecipes++;
          continue;
        }

        await db.insert(comboItems).values({
          comboId: comboRow.id,
          baseProductId: product.id,
          sequence,
        });
        itemCount++;
      }

      const flag = ok ? '' : '  <-- SHORTFALL, seeded inactive';
      console.log(
        `    ${combo.name.padEnd(26)} $${String(combo.priceMxn).padStart(5)}` +
          `  ${combo.recipe.length} call(s)  ${delivered.toLocaleString('en-US')} 💎${flag}`,
      );
    }
  }

  await db
    .insert(settings)
    .values({ key: 'fx_usd_mxn', value: { rate: Number(process.env.FX_USD_MXN ?? 18.5) } })
    .onConflictDoNothing();

  console.log(
    `\n${campaignCount} campaigns, ${comboCount} combos, ${itemCount} recipe items linked.`,
  );

  if (skippedRecipes > 0) {
    console.log(
      `\n${skippedRecipes} recipe item(s) unlinked — base_products is empty until the\n` +
        'provider catalog sync runs. Re-run this seed after Phase 0 resolves the\n' +
        'real product IDs.',
    );
  }

  if (shortfalls.length > 0) {
    console.log(`\n${shortfalls.length} combo(s) seeded INACTIVE because they under-deliver:`);
    for (const s of shortfalls) console.log(`  - ${s}`);
    console.log('Confirm the corrected figures with the client before activating.');
  }
}

seed()
  .then(() => client.end())
  .catch(async (err) => {
    console.error('\nSeed failed:', err);
    await client.end();
    process.exitCode = 1;
  });
