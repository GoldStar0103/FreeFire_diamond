/**
 * `DrizzleItemOrderQueue` and `DrizzleItemFulfillmentStore` against real
 * Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { ItemReviewConflictError } from '@levelup/engine';
import { createDb, type Database } from '../index.js';
import { adminUsers, auditLog, itemOrderDetails, notifications, orders, playerProfiles } from '../schema.js';
import { DrizzleItemFulfillmentStore, DrizzleItemOrderQueue } from './item-fulfillment-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_item_fulfillment_test';

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
    raw`TRUNCATE orders, order_items, item_order_details, player_profiles, notifications, admin_users, audit_log RESTART IDENTITY CASCADE`,
  );
});

async function seedAdmin(email = 'dueno@levelupstore.mx') {
  const [admin] = await db.insert(adminUsers).values({ email, passwordHash: 'x' }).returning({ id: adminUsers.id });
  return admin!.id;
}

async function seedProfile(playerId = '100001') {
  const [profile] = await db
    .insert(playerProfiles)
    .values({ playerId, email: `${playerId}@test.levelup` })
    .returning();
  return profile!;
}

async function seedItemOrder(opts: {
  orderNumber: string;
  orderStatus?: 'payment_confirmed' | 'processing' | 'partially_delivered' | 'completed' | 'needs_review';
  fulfillmentStatus?: 'pending' | 'processing' | 'delivered' | 'partial' | 'failed' | 'awaiting_stock' | 'cancelled';
  rocketpassOrderId?: string | null;
  playerProfileId?: string | null;
  ageSeconds?: number;
  sku?: string;
  region?: string | null;
}) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: opts.orderNumber,
      playerId: '7288567050',
      playerProfileId: opts.playerProfileId ?? null,
      orderType: 'item',
      comboKey: null,
      comboSnapshot: {},
      priceMxnCents: 10_000,
      status: opts.orderStatus ?? 'payment_confirmed',
      createdAt: raw`now() - make_interval(secs => ${opts.ageSeconds ?? 0})`,
      updatedAt: raw`now() - make_interval(secs => ${opts.ageSeconds ?? 0})`,
    })
    .returning();

  await db.insert(itemOrderDetails).values({
    orderId: order!.id,
    itemSku: opts.sku ?? 'crate',
    itemNameSnapshot: 'Universal Evo Token Crate',
    quantity: 1,
    region: opts.region === undefined ? 'SAC' : opts.region,
    unitPriceSnapshotCents: 10_000,
    fulfillmentStatus: opts.fulfillmentStatus ?? 'pending',
    rocketpassOrderId: opts.rocketpassOrderId ?? null,
    createdAt: raw`now() - make_interval(secs => ${opts.ageSeconds ?? 0})`,
    updatedAt: raw`now() - make_interval(secs => ${opts.ageSeconds ?? 0})`,
  });

  return order!;
}

describe.skipIf(!PG_AVAILABLE)('DrizzleItemOrderQueue.claimNext', () => {
  it('claims a pending item order and marks the order processing', async () => {
    const order = await seedItemOrder({ orderNumber: 'LU-1' });
    const claimed = await new DrizzleItemOrderQueue(db).claimNext(300_000);

    expect(claimed?.orderNumber).toBe('LU-1');
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row?.status).toBe('processing');
  });

  it('claims an awaiting_stock item too — that is the whole retry mechanism', async () => {
    await seedItemOrder({ orderNumber: 'LU-1', fulfillmentStatus: 'awaiting_stock' });
    expect((await new DrizzleItemOrderQueue(db).claimNext(300_000))?.orderNumber).toBe('LU-1');
  });

  it('never claims a diamond order', async () => {
    await db.insert(orders).values({
      orderNumber: 'LU-DIAMOND',
      playerId: '7288567050',
      orderType: 'diamonds',
      comboKey: 'mega_prime_48k',
      comboSnapshot: {},
      priceMxnCents: 10_000,
      status: 'payment_confirmed',
    });
    expect(await new DrizzleItemOrderQueue(db).claimNext(300_000)).toBeNull();
  });

  it('never reclaims a stale processing order that already has a rocketpass_order_id — that belongs to the poller/webhook', async () => {
    await seedItemOrder({
      orderNumber: 'LU-1',
      orderStatus: 'processing',
      fulfillmentStatus: 'processing',
      rocketpassOrderId: 'ORD-already-placed',
      ageSeconds: 9999,
    });
    expect(await new DrizzleItemOrderQueue(db).claimNext(300_000)).toBeNull();
  });

  it('recovers a stale processing order that crashed before getting a rocketpass_order_id', async () => {
    await seedItemOrder({
      orderNumber: 'LU-1',
      orderStatus: 'processing',
      fulfillmentStatus: 'processing',
      rocketpassOrderId: null,
      ageSeconds: 9999,
    });
    const claimed = await new DrizzleItemOrderQueue(db).claimNext(300_000);
    expect(claimed).toMatchObject({ orderNumber: 'LU-1', recovered: true });
  });

  it('leaves a fresh (not yet stale) processing order with no id alone', async () => {
    await seedItemOrder({
      orderNumber: 'LU-1',
      orderStatus: 'processing',
      fulfillmentStatus: 'processing',
      rocketpassOrderId: null,
      ageSeconds: 5,
    });
    expect(await new DrizzleItemOrderQueue(db).claimNext(300_000)).toBeNull();
  });

  it('never hands the same order to two workers', async () => {
    await seedItemOrder({ orderNumber: 'LU-1' });
    const [a, b] = await Promise.all([
      new DrizzleItemOrderQueue(db).claimNext(300_000),
      new DrizzleItemOrderQueue(db).claimNext(300_000),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe.skipIf(!PG_AVAILABLE)('DrizzleItemFulfillmentStore', () => {
  it('loadItemOrder maps the join correctly', async () => {
    const order = await seedItemOrder({ orderNumber: 'LU-1', sku: 'token', region: 'US' });
    const loaded = await new DrizzleItemFulfillmentStore(db).loadItemOrder(order.id);
    expect(loaded).toMatchObject({
      orderNumber: 'LU-1',
      playerId: '7288567050',
      sku: 'token',
      region: 'US',
      fulfillmentStatus: 'pending',
      rocketpassOrderId: null,
      attemptCount: 0,
    });
  });

  it('loadItemOrder returns null for a non-item order', async () => {
    expect(await new DrizzleItemFulfillmentStore(db).loadItemOrder('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('markSending bumps the attempt count and moves the item to processing', async () => {
    const order = await seedItemOrder({ orderNumber: 'LU-1' });
    await new DrizzleItemFulfillmentStore(db).markSending(order.id);

    const [row] = await db.select().from(itemOrderDetails).where(eq(itemOrderDetails.orderId, order.id));
    expect(row).toMatchObject({ fulfillmentStatus: 'processing', attemptCount: 1 });
  });

  it('applyDecision with a completed decision moves the order to completed, stamps completedAt, and notifies', async () => {
    const profile = await seedProfile();
    const order = await seedItemOrder({ orderNumber: 'LU-1', playerProfileId: profile.id });

    await new DrizzleItemFulfillmentStore(db).applyDecision(order.id, {
      itemStatus: 'delivered',
      orderStatus: 'completed',
      rocketpassOrderId: 'ORD-1',
      alert: null,
    });

    const [item] = await db.select().from(itemOrderDetails).where(eq(itemOrderDetails.orderId, order.id));
    expect(item).toMatchObject({ fulfillmentStatus: 'delivered', rocketpassOrderId: 'ORD-1' });

    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row?.status).toBe('completed');
    expect(row?.completedAt).toBeInstanceOf(Date);

    const [notif] = await db.select().from(notifications).where(eq(notifications.orderId, order.id));
    expect(notif).toMatchObject({ type: 'order_delivered', playerProfileId: profile.id });
  });

  it('applyDecision with a needs_review decision notifies order_failed, and stays silent for a guest order', async () => {
    const order = await seedItemOrder({ orderNumber: 'LU-1' }); // no account

    await new DrizzleItemFulfillmentStore(db).applyDecision(order.id, {
      itemStatus: 'failed',
      orderStatus: 'needs_review',
      rocketpassOrderId: null,
      alert: null,
    });

    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row?.status).toBe('needs_review');
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it('applyDecision with no orderStatus change leaves orders.status alone', async () => {
    const order = await seedItemOrder({ orderNumber: 'LU-1', orderStatus: 'processing' });

    await new DrizzleItemFulfillmentStore(db).applyDecision(order.id, {
      itemStatus: 'awaiting_stock',
      orderStatus: null,
      rocketpassOrderId: null,
      alert: null,
    });

    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row?.status).toBe('processing');
    const [item] = await db.select().from(itemOrderDetails).where(eq(itemOrderDetails.orderId, order.id));
    expect(item?.fulfillmentStatus).toBe('awaiting_stock');
  });

  it('findItemOrderByRocketpassId finds the order and its attempt count', async () => {
    const order = await seedItemOrder({ orderNumber: 'LU-1', rocketpassOrderId: 'ORD-1' });
    await db.update(itemOrderDetails).set({ attemptCount: 2 }).where(eq(itemOrderDetails.orderId, order.id));

    const found = await new DrizzleItemFulfillmentStore(db).findItemOrderByRocketpassId('ORD-1');
    expect(found).toEqual({ orderId: order.id, attemptCount: 2 });
  });

  it('findItemOrderByRocketpassId returns null for an id it has never placed', async () => {
    expect(await new DrizzleItemFulfillmentStore(db).findItemOrderByRocketpassId('ORD-unknown')).toBeNull();
  });

  it('never sends a second order_delivered notification for the same order', async () => {
    const profile = await seedProfile();
    const order = await seedItemOrder({ orderNumber: 'LU-1', playerProfileId: profile.id });
    const store = new DrizzleItemFulfillmentStore(db);
    const decision = { itemStatus: 'delivered' as const, orderStatus: 'completed' as const, rocketpassOrderId: 'ORD-1', alert: null };

    await store.applyDecision(order.id, decision);
    await store.applyDecision(order.id, decision);

    expect(await db.select().from(notifications).where(eq(notifications.orderId, order.id))).toHaveLength(1);
  });

  it('listPendingItemOrders finds a stale processing order with a RocketPass id on file', async () => {
    const order = await seedItemOrder({
      orderNumber: 'LU-1',
      orderStatus: 'processing',
      fulfillmentStatus: 'processing',
      rocketpassOrderId: 'ORD-1',
      ageSeconds: 120,
    });

    const found = await new DrizzleItemFulfillmentStore(db).listPendingItemOrders({ olderThanMs: 30_000, limit: 10 });
    expect(found).toEqual([{ orderId: order.id, orderNumber: 'LU-1', rocketpassOrderId: 'ORD-1', attemptCount: 0 }]);
  });

  it('listPendingItemOrders skips an order too fresh to ask about yet', async () => {
    await seedItemOrder({
      orderNumber: 'LU-1',
      orderStatus: 'processing',
      fulfillmentStatus: 'processing',
      rocketpassOrderId: 'ORD-1',
      ageSeconds: 5,
    });

    expect(await new DrizzleItemFulfillmentStore(db).listPendingItemOrders({ olderThanMs: 30_000, limit: 10 })).toEqual([]);
  });

  it('listPendingItemOrders ignores a processing order with no RocketPass id yet — that belongs to the claim/recovery path', async () => {
    await seedItemOrder({
      orderNumber: 'LU-1',
      orderStatus: 'processing',
      fulfillmentStatus: 'processing',
      rocketpassOrderId: null,
      ageSeconds: 120,
    });

    expect(await new DrizzleItemFulfillmentStore(db).listPendingItemOrders({ olderThanMs: 30_000, limit: 10 })).toEqual([]);
  });

  it('listPendingItemOrders ignores an order that already settled', async () => {
    await seedItemOrder({
      orderNumber: 'LU-1',
      orderStatus: 'completed',
      fulfillmentStatus: 'delivered',
      rocketpassOrderId: 'ORD-1',
      ageSeconds: 120,
    });

    expect(await new DrizzleItemFulfillmentStore(db).listPendingItemOrders({ olderThanMs: 30_000, limit: 10 })).toEqual([]);
  });
});

describe.skipIf(!PG_AVAILABLE)('DrizzleItemFulfillmentStore manual release', () => {
  it('loadItemOrderForReview reads the order status and RocketPass id', async () => {
    const order = await seedItemOrder({ orderNumber: 'LU-1', orderStatus: 'needs_review', rocketpassOrderId: 'ORD-1' });
    const found = await new DrizzleItemFulfillmentStore(db).loadItemOrderForReview(order.id);
    expect(found).toEqual({ orderId: order.id, orderNumber: 'LU-1', orderStatus: 'needs_review', rocketpassOrderId: 'ORD-1' });
  });

  it('loadItemOrderForReview returns null for a non-item order', async () => {
    expect(
      await new DrizzleItemFulfillmentStore(db).loadItemOrderForReview('00000000-0000-0000-0000-000000000000'),
    ).toBeNull();
  });

  it('releaseItemOrderManually completes the order, marks the item delivered, notifies, and audits', async () => {
    const adminId = await seedAdmin();
    const profile = await seedProfile();
    const order = await seedItemOrder({
      orderNumber: 'LU-1',
      orderStatus: 'needs_review',
      fulfillmentStatus: 'failed',
      playerProfileId: profile.id,
    });

    await new DrizzleItemFulfillmentStore(db).releaseItemOrderManually({
      orderId: order.id,
      expectedOrderStatus: 'needs_review',
      adminUserId: adminId,
      note: 'Checked RocketPass portal directly, order was delivered',
    });

    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row?.status).toBe('completed');
    expect(row?.completedAt).toBeInstanceOf(Date);

    const [item] = await db.select().from(itemOrderDetails).where(eq(itemOrderDetails.orderId, order.id));
    expect(item?.fulfillmentStatus).toBe('delivered');

    const [notif] = await db.select().from(notifications).where(eq(notifications.orderId, order.id));
    expect(notif).toMatchObject({ type: 'order_delivered', playerProfileId: profile.id });

    const [audit] = await db.select().from(auditLog).where(eq(auditLog.entityId, order.id));
    expect(audit).toMatchObject({ action: 'item_review.released_manually' });
    expect(audit?.detail).toMatchObject({ from: 'needs_review', to: 'completed' });
  });

  it('releaseItemOrderManually stays silent for a guest order', async () => {
    const adminId = await seedAdmin();
    const order = await seedItemOrder({ orderNumber: 'LU-1', orderStatus: 'processing' });

    await new DrizzleItemFulfillmentStore(db).releaseItemOrderManually({
      orderId: order.id,
      expectedOrderStatus: 'processing',
      adminUserId: adminId,
      note: 'Confirmed delivered',
    });

    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it('releaseItemOrderManually refuses when the order already moved out from under the admin', async () => {
    const adminId = await seedAdmin();
    const order = await seedItemOrder({ orderNumber: 'LU-1', orderStatus: 'completed' });

    await expect(
      new DrizzleItemFulfillmentStore(db).releaseItemOrderManually({
        orderId: order.id,
        expectedOrderStatus: 'needs_review',
        adminUserId: adminId,
        note: 'Confirmed delivered',
      }),
    ).rejects.toThrow(ItemReviewConflictError);
  });

  it('retryItemOrderManually puts the order back to payment_confirmed with a fresh retry budget', async () => {
    const adminId = await seedAdmin();
    const order = await seedItemOrder({
      orderNumber: 'LU-1',
      orderStatus: 'needs_review',
      fulfillmentStatus: 'failed',
      rocketpassOrderId: null,
    });
    await db.update(itemOrderDetails).set({ attemptCount: 3 }).where(eq(itemOrderDetails.orderId, order.id));

    await new DrizzleItemFulfillmentStore(db).retryItemOrderManually({
      orderId: order.id,
      expectedOrderStatus: 'needs_review',
      adminUserId: adminId,
      note: 'Topped up the RocketPass balance, safe to retry',
    });

    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row?.status).toBe('payment_confirmed');

    const [item] = await db.select().from(itemOrderDetails).where(eq(itemOrderDetails.orderId, order.id));
    expect(item).toMatchObject({ fulfillmentStatus: 'pending', attemptCount: 0 });

    const [audit] = await db.select().from(auditLog).where(eq(auditLog.entityId, order.id));
    expect(audit).toMatchObject({ action: 'item_review.retried_manually' });
    expect(audit?.detail).toMatchObject({ from: 'needs_review', to: 'payment_confirmed' });
  });

  it('retryItemOrderManually refuses when the order already moved out from under the admin', async () => {
    const adminId = await seedAdmin();
    const order = await seedItemOrder({ orderNumber: 'LU-1', orderStatus: 'completed' });

    await expect(
      new DrizzleItemFulfillmentStore(db).retryItemOrderManually({
        orderId: order.id,
        expectedOrderStatus: 'needs_review',
        adminUserId: adminId,
        note: 'Topped up the balance',
      }),
    ).rejects.toThrow(ItemReviewConflictError);
  });
});
