/**
 * `DrizzleItemOrderingStore` + `findResumableItemOrder` against real Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import type { NewItemOrder } from '@levelup/engine';
import { createDb, type Database } from '../index.js';
import { itemCatalog, itemOrderDetails, itemStock, orders, payments } from '../schema.js';
import { DrizzleItemOrderingStore, findResumableItemOrder } from './item-ordering-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_item_ordering_store_test';

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
  await db.execute(raw`TRUNCATE orders, item_catalog, item_stock RESTART IDENTITY CASCADE`);
});

const store = () => new DrizzleItemOrderingStore(db);

async function seedCrate() {
  const [row] = await db
    .insert(itemCatalog)
    .values({
      sku: 'crate',
      displayName: 'Evo Crate',
      rocketpassName: 'Universal Evo Token Crate',
      kind: 'gift',
      priceArs: '1000.00',
      maxQuantity: 10,
    })
    .returning();
  await db.insert(itemStock).values({ itemCatalogId: row!.id, region: 'US', quantity: 5 });
  return row!;
}

const newOrder = (overrides: Partial<NewItemOrder> = {}): NewItemOrder => ({
  orderNumber: 'LU-261116-TEST',
  playerId: '123456789',
  playerNickname: null,
  contactWhatsapp: '5215512345678',
  priceMxnCents: 4200,
  paymentMethod: 'card',
  item: {
    itemSku: 'crate',
    itemName: 'Evo Crate',
    kind: 'gift',
    quantity: 2,
    region: 'US',
    unitPriceMxnCents: 2100,
    unitCostMxnCents: 1500,
    frozenAt: new Date().toISOString(),
  },
  playerProfileId: null,
  ...overrides,
});

describe.skipIf(!PG_AVAILABLE)('DrizzleItemOrderingStore.findItemForOrder', () => {
  it('returns the item with stock grouped by region', async () => {
    await seedCrate();
    const item = await store().findItemForOrder('crate');
    expect(item).toMatchObject({ sku: 'crate', priceArs: 1000, stockByRegion: { US: 5 } });
  });

  it('returns null for an unknown sku', async () => {
    expect(await store().findItemForOrder('nope')).toBeNull();
  });
});

describe.skipIf(!PG_AVAILABLE)('DrizzleItemOrderingStore.persist', () => {
  it('writes the order, item detail, and payment in one go', async () => {
    const { id, orderNumber } = await store().persist(newOrder());

    const [order] = await db.select().from(orders).where(eq(orders.id, id));
    expect(order).toMatchObject({
      orderNumber,
      orderType: 'item',
      comboId: null,
      comboKey: null,
      priceMxnCents: 4200,
      status: 'pending_payment',
    });

    const [detail] = await db.select().from(itemOrderDetails).where(eq(itemOrderDetails.orderId, id));
    expect(detail).toMatchObject({
      itemSku: 'crate',
      itemNameSnapshot: 'Evo Crate',
      quantity: 2,
      region: 'US',
      unitPriceSnapshotCents: 2100,
      unitCostCentsSnapshot: 1500,
      fulfillmentStatus: 'pending',
    });

    const [payment] = await db.select().from(payments).where(eq(payments.orderId, id));
    expect(payment).toMatchObject({ method: 'card', status: 'pending', amountExpectedCents: 4200 });
    // card is an instant method — 2h TTL, not the 48h manual one.
    if (!payment?.expiresAt || !order) throw new Error('expected payment.expiresAt and order');
    expect(payment.expiresAt.getTime() - order.createdAt.getTime()).toBeLessThan(3 * 60 * 60 * 1000);
  });
});

describe.skipIf(!PG_AVAILABLE)('findResumableItemOrder', () => {
  it('finds a still-pending order for the same player, sku, and quantity', async () => {
    const { orderNumber } = await store().persist(newOrder());
    const resumable = await findResumableItemOrder(db, { playerId: '123456789', sku: 'crate', quantity: 2 });
    expect(resumable?.orderNumber).toBe(orderNumber);
  });

  it('ignores an order under review', async () => {
    const { id } = await store().persist(newOrder());
    await db.update(payments).set({ status: 'under_review' }).where(eq(payments.orderId, id));
    expect(await findResumableItemOrder(db, { playerId: '123456789', sku: 'crate', quantity: 2 })).toBeNull();
  });

  it('never matches a different sku', async () => {
    await store().persist(newOrder());
    expect(await findResumableItemOrder(db, { playerId: '123456789', sku: 'token', quantity: 2 })).toBeNull();
  });

  it('never matches a different quantity — a changed quantity must charge the new amount, not the old one', async () => {
    await store().persist(newOrder());
    expect(await findResumableItemOrder(db, { playerId: '123456789', sku: 'crate', quantity: 10 })).toBeNull();
  });

  it('surfaces the attached gatewayChargeId so a caller can re-check a still-live SPEI reference', async () => {
    const { id } = await store().persist(newOrder());
    await db
      .update(payments)
      .set({ gateway: 'mercadopago_embedded', gatewayChargeId: 'mp-order-123' })
      .where(eq(payments.orderId, id));
    const resumable = await findResumableItemOrder(db, { playerId: '123456789', sku: 'crate', quantity: 2 });
    expect(resumable?.gatewayChargeId).toBe('mp-order-123');
  });
});
