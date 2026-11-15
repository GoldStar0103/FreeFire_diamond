/**
 * `DrizzleRocketPassCatalogStore` against real Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { itemCatalog, itemStock } from '../schema.js';
import { DrizzleRocketPassCatalogStore } from './rocketpass-catalog-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_rocketpass_catalog_test';

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

const store = () => new DrizzleRocketPassCatalogStore(db);

describe.skipIf(!PG_AVAILABLE)('upsertCatalog', () => {
  it('creates a new SKU with stock rows per region', async () => {
    const syncedAt = new Date('2026-09-23T14:00:00Z');
    await store().upsertCatalog(
      [
        {
          sku: 'crate',
          name: 'Universal Evo Token Crate',
          kind: 'gift',
          priceArs: 400,
          maxQuantity: 500,
          available: true,
          stockByRegion: { SAC: 312, US: 87 },
        },
      ],
      syncedAt,
    );

    const [row] = await db.select().from(itemCatalog).where(eq(itemCatalog.sku, 'crate'));
    expect(row).toMatchObject({
      sku: 'crate',
      displayName: 'Universal Evo Token Crate',
      rocketpassName: 'Universal Evo Token Crate',
      kind: 'gift',
      priceArs: '400.00',
      maxQuantity: 500,
      active: true,
      rocketpassAvailable: true,
    });

    const stock = await db.select().from(itemStock).where(eq(itemStock.itemCatalogId, row!.id));
    expect(stock.map((s) => [s.region, s.quantity]).sort()).toEqual([
      ['SAC', 312],
      ['US', 87],
    ]);
  });

  it('creates a membership item with no stock rows at all', async () => {
    await store().upsertCatalog(
      [
        {
          sku: 'weekly',
          name: 'Weekly Membership',
          kind: 'membership',
          priceArs: 1200,
          maxQuantity: 1,
          available: true,
          stockByRegion: null,
        },
      ],
      new Date(),
    );

    const [row] = await db.select().from(itemCatalog).where(eq(itemCatalog.sku, 'weekly'));
    expect(row?.kind).toBe('membership');
    expect(await db.select().from(itemStock)).toHaveLength(0);
  });

  it('updates price/availability/stock on a re-sync, but never touches an edited display name', async () => {
    await store().upsertCatalog(
      [
        {
          sku: 'crate',
          name: 'Universal Evo Token Crate',
          kind: 'gift',
          priceArs: 400,
          maxQuantity: 500,
          available: true,
          stockByRegion: { SAC: 312 },
        },
      ],
      new Date('2026-09-23T14:00:00Z'),
    );

    // Jose renames it for the storefront — a sync must never overwrite this.
    await db.update(itemCatalog).set({ displayName: 'Evo Crate' }).where(eq(itemCatalog.sku, 'crate'));

    await store().upsertCatalog(
      [
        {
          sku: 'crate',
          name: 'Universal Evo Token Crate',
          kind: 'gift',
          priceArs: 450,
          maxQuantity: 500,
          available: false,
          stockByRegion: { SAC: 0 },
        },
      ],
      new Date('2026-09-23T15:00:00Z'),
    );

    const [row] = await db.select().from(itemCatalog).where(eq(itemCatalog.sku, 'crate'));
    expect(row).toMatchObject({ displayName: 'Evo Crate', priceArs: '450.00', rocketpassAvailable: false });

    const [stockRow] = await db.select().from(itemStock).where(eq(itemStock.itemCatalogId, row!.id));
    expect(stockRow?.quantity).toBe(0);
  });

  it('leaves the admin-set `active` switch alone on every sync', async () => {
    await store().upsertCatalog(
      [
        {
          sku: 'crate',
          name: 'Universal Evo Token Crate',
          kind: 'gift',
          priceArs: 400,
          maxQuantity: 500,
          available: true,
          stockByRegion: { SAC: 312 },
        },
      ],
      new Date(),
    );
    await db.update(itemCatalog).set({ active: false }).where(eq(itemCatalog.sku, 'crate'));

    await store().upsertCatalog(
      [
        {
          sku: 'crate',
          name: 'Universal Evo Token Crate',
          kind: 'gift',
          priceArs: 400,
          maxQuantity: 500,
          available: true,
          stockByRegion: { SAC: 312 },
        },
      ],
      new Date(),
    );

    const [row] = await db.select().from(itemCatalog).where(eq(itemCatalog.sku, 'crate'));
    expect(row?.active).toBe(false);
  });
});
