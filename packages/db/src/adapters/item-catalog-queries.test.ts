/**
 * `listStorefrontItems`/`getStorefrontItem` against real Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { itemCatalog, itemStock } from '../schema.js';
import { getStorefrontItem, listStorefrontItems } from './item-catalog-queries.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_item_catalog_queries_test';

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
  await db.execute(raw`TRUNCATE item_catalog, item_stock RESTART IDENTITY CASCADE`);
});

const PRICING = { arsRate: 0.015, markupPercent: 40 };

async function seedCrate(overrides: Partial<{ active: boolean; rocketpassAvailable: boolean }> = {}) {
  const [row] = await db
    .insert(itemCatalog)
    .values({
      sku: 'crate',
      displayName: 'Evo Crate',
      rocketpassName: 'Universal Evo Token Crate',
      kind: 'gift',
      priceArs: '1000.00',
      maxQuantity: 10,
      active: overrides.active ?? true,
      rocketpassAvailable: overrides.rocketpassAvailable ?? true,
    })
    .returning();
  await db.insert(itemStock).values([
    { itemCatalogId: row!.id, region: 'US', quantity: 5 },
    { itemCatalogId: row!.id, region: 'SAC', quantity: 0 },
  ]);
  return row!;
}

describe.skipIf(!PG_AVAILABLE)('listStorefrontItems', () => {
  it('computes the sale price from ARS cost plus the markup, never leaking the ARS figure', async () => {
    await seedCrate();
    const items = await listStorefrontItems(db, PRICING);
    expect(items).toHaveLength(1);
    // cost: 1000 * 0.015 = 15 MXN = 1500 cents; sale: 1500 * 1.4 = 2100
    expect(items[0]).toMatchObject({
      sku: 'crate',
      displayName: 'Evo Crate',
      salePriceMxnCents: 2100,
      stockByRegion: { US: 5, SAC: 0 },
    });
    expect(items[0]).not.toHaveProperty('priceArs');
  });

  it('excludes an item the admin turned off', async () => {
    await seedCrate({ active: false });
    expect(await listStorefrontItems(db, PRICING)).toHaveLength(0);
  });

  it('excludes an item RocketPass itself no longer reports available', async () => {
    await seedCrate({ rocketpassAvailable: false });
    expect(await listStorefrontItems(db, PRICING)).toHaveLength(0);
  });
});

describe.skipIf(!PG_AVAILABLE)('getStorefrontItem', () => {
  it('returns null for an item that is off', async () => {
    await seedCrate({ active: false });
    expect(await getStorefrontItem(db, 'crate', PRICING)).toBeNull();
  });

  it('returns the item with per-region stock when sellable', async () => {
    await seedCrate();
    const item = await getStorefrontItem(db, 'crate', PRICING);
    expect(item?.stockByRegion).toEqual({ US: 5, SAC: 0 });
  });

  it('returns null for an unknown sku', async () => {
    expect(await getStorefrontItem(db, 'nope', PRICING)).toBeNull();
  });
});
