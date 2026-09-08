/**
 * Catalog sync against real Postgres, end to end: an empty database, a provider
 * catalog, and afterwards a combo that can actually be ordered.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { ProviderSimulator, type ProviderProduct, type UsdTenK } from '@levelup/provider';
import { createOrder, syncCatalog } from '@levelup/engine';
import { createDb, type Database } from '../index.js';
import { baseProducts, campaigns, comboItems, combos } from '../schema.js';
import { DrizzleCatalogSyncStore } from './catalog-sync-store.js';
import { DrizzleOrderingStore } from './ordering-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_catalog_test';

const PG_AVAILABLE = await (async () => {
  const probe = postgres(`${BASE_URL}/postgres`, { max: 1, connect_timeout: 3 });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 2 }).catch(() => undefined);
  }
})();

let db: Database;
let client: ReturnType<typeof createDb>['client'];

beforeAll(async () => {
  if (!PG_AVAILABLE) return;
  const admin = postgres(`${BASE_URL}/postgres`, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  ({ db, client } = createDb(`${BASE_URL}/${TEST_DB}`, { max: 5 }));
  await migrate(db, { migrationsFolder: MIGRATIONS });
}, 180_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
}, 30_000);

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(
    raw`TRUNCATE orders, order_items, payments, combo_items, combos, campaigns, base_products RESTART IDENTITY CASCADE`,
  );
});

const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;

const catalogOf = (denominations: number[], costFor: (d: number) => number): ProviderProduct[] =>
  denominations.map((d) => ({
    providerProductId: `d${d}`,
    endpointKind: 'pins_recharge' as const,
    name: `Free Fire ${d} Diamonds`,
    sku: `FF${d}`,
    diamondsBase: d,
    costUsd: usd(costFor(d)),
    requiresServerId: false,
    canValidate: true,
    raw: {},
  }));

function syncWith(catalog: ProviderProduct[]) {
  const provider = new ProviderSimulator();
  provider.programCatalog(catalog);
  return syncCatalog({ store: new DrizzleCatalogSyncStore(db), provider });
}

const ALL_SIX = [100, 310, 520, 1060, 2180, 5600];

describe.skipIf(!PG_AVAILABLE)('first sync', () => {
  it('populates base_products from an empty database', async () => {
    const result = await syncWith(catalogOf(ALL_SIX, (d) => d / 200));

    expect(result.mapped).toEqual(ALL_SIX);
    expect(result.added).toHaveLength(6);
    expect(result.blocked).toBe(false);

    const rows = await db.select().from(baseProducts);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.active)).toBe(true);
    expect(rows.every((r) => r.lastSyncedAt !== null)).toBe(true);

    const [big] = await db
      .select()
      .from(baseProducts)
      .where(eq(baseProducts.diamondsBase, 5600));
    expect(big?.costUsd).toBe('28.0000');
    expect(big?.canValidate).toBe(true);
  });

  it('is idempotent', async () => {
    await syncWith(catalogOf(ALL_SIX, (d) => d / 200));
    const second = await syncWith(catalogOf(ALL_SIX, (d) => d / 200));

    expect(second.added).toHaveLength(0);
    expect(second.updated).toHaveLength(6);
    expect(second.costChanges).toHaveLength(0);
    expect(await db.select().from(baseProducts)).toHaveLength(6);
  });
});

describe.skipIf(!PG_AVAILABLE)('cost drift', () => {
  it('detects and persists a price rise', async () => {
    await syncWith(catalogOf([5600], () => 27.5));
    const result = await syncWith(catalogOf([5600], () => 30));

    expect(result.costChanges).toHaveLength(1);
    expect(result.costChanges[0]?.pctChange).toBeCloseTo(9.09, 1);

    const [row] = await db.select().from(baseProducts);
    expect(row?.costUsd).toBe('30.0000');
  });
});

describe.skipIf(!PG_AVAILABLE)('withdrawn products', () => {
  it('deactivates without deleting, preserving recipe references', async () => {
    await syncWith(catalogOf(ALL_SIX, (d) => d / 200));

    // The provider stops offering 310.
    const result = await syncWith(catalogOf(ALL_SIX.filter((d) => d !== 310), (d) => d / 200));

    expect(result.deactivated).toEqual(['d310']);
    expect(result.missing).toEqual([310]);

    const rows = await db.select().from(baseProducts);
    // Still six rows — the withdrawn one is inactive, not gone.
    expect(rows).toHaveLength(6);
    const [withdrawn] = rows.filter((r) => r.providerProductId === 'd310');
    expect(withdrawn?.active).toBe(false);
  });

  it('reactivates a product the provider starts offering again', async () => {
    await syncWith(catalogOf(ALL_SIX, (d) => d / 200));
    await syncWith(catalogOf(ALL_SIX.filter((d) => d !== 310), (d) => d / 200));
    await syncWith(catalogOf(ALL_SIX, (d) => d / 200));

    const [restored] = await db
      .select()
      .from(baseProducts)
      .where(eq(baseProducts.providerProductId, 'd310'));
    expect(restored?.active).toBe(true);
  });
});

describe.skipIf(!PG_AVAILABLE)('unusable catalog', () => {
  it('stores nothing when everything is a redeemable code', async () => {
    const codes = catalogOf(ALL_SIX, (d) => d / 200).map((p) => ({
      ...p,
      endpointKind: 'pins_code' as const,
      canValidate: false,
    }));

    const result = await syncWith(codes);

    // The whole "recarga directa al ID" premise fails on this catalog.
    expect(result.blocked).toBe(true);
    expect(result.skipped).toHaveLength(6);
    expect(await db.select().from(baseProducts)).toHaveLength(0);
  });
});

describe.skipIf(!PG_AVAILABLE)('the point of all this', () => {
  it('turns an unorderable combo into an orderable one', async () => {
    // Seed a combo whose recipe has no products yet — the state the real
    // database is in right now, with 59 recipe items unlinked.
    const [campaign] = await db
      .insert(campaigns)
      .values({ key: 'chidos', name: 'DESCUENTOS CHIDOS' })
      .returning();
    const [combo] = await db
      .insert(combos)
      .values({
        campaignId: campaign!.id,
        key: 'chidos_3000',
        name: 'Descuentos Chidos 3000',
        priceMxnCents: 40_000,
        advertisedDiamonds: 3000,
      })
      .returning();

    const before = await createOrder(
      { store: new DrizzleOrderingStore(db) },
      {
        comboKey: 'chidos_3000',
        playerId: '7288567050',
        paymentMethod: 'transfer_manual',
        source: 'storefront',
      },
    );
    expect(before).toMatchObject({ failure: { code: 'RECIPE_EMPTY' } });

    // Sync the provider catalog, then wire the recipe (what re-running the
    // seed does): 2,180 + 520 + 100 delivers 3,080 against 3,000 advertised.
    await syncWith(catalogOf(ALL_SIX, (d) => d / 200));
    const products = await db.select().from(baseProducts);
    const byDenomination = new Map(products.map((p) => [p.diamondsBase, p.id]));

    await db.insert(comboItems).values(
      [2180, 520, 100].map((d, index) => ({
        comboId: combo!.id,
        baseProductId: byDenomination.get(d)!,
        sequence: index,
      })),
    );

    const after = await createOrder(
      { store: new DrizzleOrderingStore(db) },
      {
        comboKey: 'chidos_3000',
        playerId: '7288567050',
        paymentMethod: 'transfer_manual',
        source: 'storefront',
      },
    );

    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error('unreachable');
    expect(after.order.items).toHaveLength(3);
    expect(after.order.comboSnapshot.deliveredDiamonds).toBe(3080);
  });

  it('reports combos still missing a recipe', async () => {
    const [campaign] = await db
      .insert(campaigns)
      .values({ key: 'chidos', name: 'DESCUENTOS CHIDOS' })
      .returning();
    await db.insert(combos).values({
      campaignId: campaign!.id,
      key: 'chidos_1700',
      name: 'Descuentos Chidos 1700',
      priceMxnCents: 26_000,
      advertisedDiamonds: 1700,
    });

    const incomplete = await new DrizzleCatalogSyncStore(db).findIncompleteRecipes();
    expect(incomplete).toEqual([
      { comboKey: 'chidos_1700', name: 'Descuentos Chidos 1700', items: 0 },
    ]);
  });
});
