/**
 * `DrizzleFulfillmentStore.loadOrder` against real Postgres.
 *
 * The join onto `base_products` is what the fulfilment engine's guard against
 * a withdrawn or reassigned product relies on — see `productActive` on
 * `OrderItemRecord`. Worth a real database: `false` vs `null` here is the
 * difference between refusing an item and dispatching it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { baseProducts, notifications, orderItems, orders, playerProfiles } from '../schema.js';
import { DrizzleFulfillmentStore } from './fulfillment-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_fulfillment_store_test';

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
    raw`TRUNCATE orders, order_items, base_products, player_profiles, notifications RESTART IDENTITY CASCADE`,
  );
});

async function order(playerProfileId?: string) {
  const [row] = await db
    .insert(orders)
    .values({
      orderNumber: 'LU-260911-FS01',
      playerId: '7288567050',
      playerProfileId: playerProfileId ?? null,
      comboKey: 'mega_10',
      comboSnapshot: {},
      priceMxnCents: 1_000,
      status: 'payment_confirmed',
    })
    .returning();
  return row!;
}

async function seedProfile(playerId = '100001') {
  const [profile] = await db
    .insert(playerProfiles)
    .values({ playerId, email: `${playerId}@test.levelup` })
    .returning();
  return profile!;
}

describe.skipIf(!PG_AVAILABLE)('loadOrder', () => {
  it('reports productActive: true for an item on an active product', async () => {
    const [product] = await db
      .insert(baseProducts)
      .values({
        providerProductId: '351',
        endpointKind: 'pins_recharge',
        name: 'Free Fire 100',
        diamondsBase: 100,
        costUsd: '0.7000',
        active: true,
      })
      .returning();
    const o = await order();
    await db.insert(orderItems).values({
      orderId: o.id,
      sequence: 0,
      baseProductId: product!.id,
      providerProductId: '351',
      diamondsBase: 100,
      costUsd: '0.7000',
      status: 'queued',
    });

    const loaded = await new DrizzleFulfillmentStore(db).loadOrder(o.id);
    expect(loaded?.items[0]).toMatchObject({ productActive: true, endpointKind: 'pins_recharge' });
  });

  it('reports productActive: false once the catalog sync deactivates it — the case fulfilment must refuse', async () => {
    const [product] = await db
      .insert(baseProducts)
      .values({
        providerProductId: '351',
        endpointKind: 'pins_recharge',
        name: 'Free Fire 100',
        diamondsBase: 100,
        costUsd: '0.7000',
        active: false, // withdrawn, or reassigned to a different denomination
      })
      .returning();
    const o = await order();
    await db.insert(orderItems).values({
      orderId: o.id,
      sequence: 0,
      baseProductId: product!.id,
      providerProductId: '351',
      diamondsBase: 100,
      costUsd: '0.7000',
      status: 'queued',
    });

    const loaded = await new DrizzleFulfillmentStore(db).loadOrder(o.id);
    expect(loaded?.items[0]?.productActive).toBe(false);
  });

  it('reports productActive: null when the item carries no product row at all', async () => {
    const o = await order();
    await db.insert(orderItems).values({
      orderId: o.id,
      sequence: 0,
      baseProductId: null,
      providerProductId: '351',
      diamondsBase: 100,
      costUsd: '0.7000',
      status: 'queued',
    });

    // null, not false — a store that cannot say must not be read as "refuse".
    const loaded = await new DrizzleFulfillmentStore(db).loadOrder(o.id);
    expect(loaded?.items[0]?.productActive).toBeNull();
    expect(loaded?.items[0]?.endpointKind).toBeNull();
  });

  it('is unaffected by an unrelated product elsewhere being inactive', async () => {
    const [active] = await db
      .insert(baseProducts)
      .values({
        providerProductId: '351',
        endpointKind: 'pins_recharge',
        name: 'Free Fire 100',
        diamondsBase: 100,
        costUsd: '0.7000',
        active: true,
      })
      .returning();
    await db.insert(baseProducts).values({
      providerProductId: '999-retired',
      endpointKind: 'pins_recharge',
      name: 'Free Fire 5600 (retired)',
      diamondsBase: 5600,
      costUsd: '33.2700',
      active: false,
    });
    const o = await order();
    await db.insert(orderItems).values({
      orderId: o.id,
      sequence: 0,
      baseProductId: active!.id,
      providerProductId: '351',
      diamondsBase: 100,
      costUsd: '0.7000',
      status: 'queued',
    });

    const loaded = await new DrizzleFulfillmentStore(db).loadOrder(o.id);
    expect(loaded?.items[0]?.productActive).toBe(true);
  });
});

async function pendingItem(o: { id: string }, status: 'sending' | 'provider_pending' = 'sending') {
  const [item] = await db
    .insert(orderItems)
    .values({
      orderId: o.id,
      sequence: 0,
      baseProductId: null,
      providerProductId: '351',
      diamondsBase: 100,
      costUsd: '0.7000',
      status,
      walletBeforeUsd: '100.0000',
    })
    .returning();
  return item!;
}

describe.skipIf(!PG_AVAILABLE)('settleItem', () => {
  it('refuses to settle an item that is no longer sending or provider_pending', async () => {
    // A live call and the poller both resolving the same stalled item is
    // exactly the race `markItemSending`'s CAS already guards against on the
    // dispatch side — settling has the same failure mode without a guard.
    const o = await order();
    const item = await pendingItem(o);
    const store = new DrizzleFulfillmentStore(db);

    await store.settleItem(item.id, { status: 'succeeded', resolvedBy: 'response' });

    await expect(
      store.settleItem(item.id, { status: 'unknown', errorCode: 'RECOVERY_INDETERMINATE' }),
    ).rejects.toThrow(/already settled/);

    const [row] = await db.select().from(orderItems).where(eq(orderItems.id, item.id));
    // The second write never landed — no overwritten status or errorCode.
    expect(row?.status).toBe('succeeded');
    expect(row?.errorCode).toBeNull();
  });

  it('a real race between the live call and the poller settling the same item never splits the row', async () => {
    const o = await order();
    const item = await pendingItem(o);
    const store = new DrizzleFulfillmentStore(db);

    const outcomes = await Promise.allSettled([
      store.settleItem(item.id, { status: 'succeeded', resolvedBy: 'response' }),
      store.settleItem(item.id, {
        status: 'unknown',
        resolvedBy: 'wallet_delta',
        errorCode: 'RECOVERY_INDETERMINATE',
      }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    // Exactly one write lands; the loser gets the CAS error, never a silent
    // overwrite of whichever settlement landed first.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const [row] = await db.select().from(orderItems).where(eq(orderItems.id, item.id));
    expect(['succeeded', 'unknown']).toContain(row?.status);
  });
});

describe.skipIf(!PG_AVAILABLE)('updateOrderStatus', () => {
  it('rings the bell on a fresh arrival at needs_review, for an order with an account', async () => {
    const profile = await seedProfile();
    const o = await order(profile.id);
    await new DrizzleFulfillmentStore(db).updateOrderStatus(o.id, 'needs_review');

    const [notif] = await db.select().from(notifications).where(eq(notifications.orderId, o.id));
    expect(notif?.type).toBe('order_failed');
    expect(notif?.playerProfileId).toBe(profile.id);
  });

  it('stays silent for a guest order with no account to notify', async () => {
    const o = await order();
    await new DrizzleFulfillmentStore(db).updateOrderStatus(o.id, 'needs_review');
    expect(await db.select().from(notifications).where(eq(notifications.orderId, o.id))).toHaveLength(0);
  });

  it('never rings the bell for an ordinary status change', async () => {
    const profile = await seedProfile();
    const o = await order(profile.id);
    await new DrizzleFulfillmentStore(db).updateOrderStatus(o.id, 'processing');
    expect(await db.select().from(notifications).where(eq(notifications.orderId, o.id))).toHaveLength(0);
  });

  it('never sends a second order_failed notification for the same order', async () => {
    const profile = await seedProfile();
    const o = await order(profile.id);
    const store = new DrizzleFulfillmentStore(db);

    await store.updateOrderStatus(o.id, 'needs_review');
    // A later call on the same order (e.g. a racing fulfilment run) must not
    // duplicate the notification — the `(order_id, type)` unique index is
    // the actual guard; this proves the write path respects it.
    await store.updateOrderStatus(o.id, 'needs_review');

    expect(await db.select().from(notifications).where(eq(notifications.orderId, o.id))).toHaveLength(1);
  });
});
