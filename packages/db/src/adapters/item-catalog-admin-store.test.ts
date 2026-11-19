/**
 * `DrizzleItemCatalogAdminStore` against real Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { itemCatalog, itemStock } from '../schema.js';
import { DrizzleItemCatalogAdminStore } from './item-catalog-admin-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_item_catalog_admin_test';

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

const store = () => new DrizzleItemCatalogAdminStore(db);

async function seedCrate() {
  const [row] = await db
    .insert(itemCatalog)
    .values({
      sku: 'crate',
      displayName: 'Universal Evo Token Crate',
      rocketpassName: 'Universal Evo Token Crate',
      kind: 'gift',
      priceArs: '1000.00',
      maxQuantity: 10,
    })
    .returning();
  await db.insert(itemStock).values({ itemCatalogId: row!.id, region: 'US', quantity: 5 });
  return row!;
}

describe.skipIf(!PG_AVAILABLE)('DrizzleItemCatalogAdminStore', () => {
  it('lists every item regardless of active/available, with stock per region', async () => {
    await seedCrate();
    const items = await store().listItemsForAdmin();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sku: 'crate',
      displayName: 'Universal Evo Token Crate',
      priceArs: 1000,
      stockByRegion: { US: 5 },
    });
  });

  it('setItemActive flips the admin switch without touching rocketpassAvailable', async () => {
    await seedCrate();
    await store().setItemActive('crate', false, 'admin-1');
    const [item] = await store().listItemsForAdmin();
    expect(item?.active).toBe(false);
    expect(item?.rocketpassAvailable).toBe(true);
  });

  it('setItemDisplayName renames the marketing name', async () => {
    await seedCrate();
    await store().setItemDisplayName('crate', 'Evo Crate', 'admin-1');
    const [item] = await store().listItemsForAdmin();
    expect(item?.displayName).toBe('Evo Crate');
    // The vendor's own name is kept, untouched, for reference.
    expect(item?.rocketpassName).toBe('Universal Evo Token Crate');
  });
});
