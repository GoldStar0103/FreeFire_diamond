/**
 * Resolving stuck orders against real Postgres: the compare-and-set guards,
 * the audit trail, and — the point of resuming — that the worker's queue
 * really does pick the order back up afterwards.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { applyReviewAction, type ReviewAction } from '@levelup/engine';
import { createDb, type Database } from '../index.js';
import { adminUsers, auditLog, orderItems, orders } from '../schema.js';
import { DrizzleOrderQueue } from './order-queue.js';
import { DrizzleReviewStore } from './review-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_review_test';

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

let adminId: string;

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(raw`TRUNCATE orders, order_items, audit_log, admin_users RESTART IDENTITY CASCADE`);
  const [admin] = await db
    .insert(adminUsers)
    .values({ email: 'dueno@levelupstore.mx', passwordHash: 'x' })
    .returning({ id: adminUsers.id });
  adminId = admin!.id;
});

type ItemStatus = NonNullable<(typeof orderItems.$inferInsert)['status']>;

/** An order parked for review, with items in the given states. */
async function stuckOrder(itemStatuses: ItemStatus[], attempts = 3) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: 'LU-260910-REV1',
      playerId: '7288567050',
      comboKey: 'mega_prime_12k',
      comboSnapshot: {},
      priceMxnCents: 153_000,
      status: 'needs_review',
      paidAt: new Date(),
    })
    .returning();

  const items = await db
    .insert(orderItems)
    .values(
      itemStatuses.map((status, sequence) => ({
        orderId: order!.id,
        sequence,
        providerProductId: '349',
        diamondsBase: 5600,
        costUsd: '33.2700',
        status,
        attemptCount: status === 'queued' ? 0 : attempts,
      })),
    )
    .returning();

  return { order: order!, items: items.sort((a, b) => a.sequence - b.sequence) };
}

const act = (orderId: string, action: ReviewAction) =>
  applyReviewAction(
    { store: new DrizzleReviewStore(db) },
    { orderId, adminUserId: adminId, action },
  );

const reload = async (orderId: string) => ({
  order: (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!,
  items: (await db.select().from(orderItems).where(eq(orderItems.orderId, orderId))).sort(
    (a, b) => a.sequence - b.sequence,
  ),
});

describe.skipIf(!PG_AVAILABLE)('settling a recharge by hand', () => {
  it('marks it delivered, completes the order, and audits who did it', async () => {
    const { order, items } = await stuckOrder(['succeeded', 'unknown']);

    const result = await act(order.id, { kind: 'mark_item_delivered', itemId: items[1]!.id });

    expect(result).toMatchObject({ ok: true, nextStatus: 'completed' });
    const after = await reload(order.id);
    expect(after.order.status).toBe('completed');
    expect(after.order.completedAt).not.toBeNull();
    expect(after.items[1]).toMatchObject({ status: 'succeeded', resolvedBy: 'manual' });

    const [audit] = await db.select().from(auditLog);
    expect(audit).toMatchObject({
      action: 'review.item_marked_delivered',
      entityId: order.id,
      adminUserId: adminId,
    });
  });

  it('re-queues a confirmed-not-charged item with a fresh budget, leaving the order parked', async () => {
    const { order, items } = await stuckOrder(['unknown']);

    await act(order.id, { kind: 'mark_item_not_delivered', itemId: items[0]!.id, confirmedNotCharged: true });

    const after = await reload(order.id);
    expect(after.order.status).toBe('needs_review');
    expect(after.items[0]).toMatchObject({ status: 'queued', attemptCount: 0 });
  });
});

describe.skipIf(!PG_AVAILABLE)('resuming', () => {
  it('puts the order back where the worker claims from', async () => {
    // Paused for a low wallet: nothing sent, everything still queued.
    const { order } = await stuckOrder(['queued', 'queued']);
    const queue = new DrizzleOrderQueue(db);

    expect(await queue.claimNext(300_000)).toBeNull();

    const result = await act(order.id, { kind: 'resume' });
    expect(result).toMatchObject({ ok: true, nextStatus: 'payment_confirmed' });

    expect(await queue.claimNext(300_000)).toMatchObject({ id: order.id });
  });

  it('resends exhausted failures after a partial delivery', async () => {
    const { order } = await stuckOrder(['succeeded', 'failed']);

    await act(order.id, { kind: 'resume' });

    const after = await reload(order.id);
    expect(after.order.status).toBe('partially_delivered');
    expect(after.items[1]).toMatchObject({ status: 'queued', attemptCount: 0 });
  });
});

describe.skipIf(!PG_AVAILABLE)('compare-and-set', () => {
  it('refuses to apply a decision about an item that changed meanwhile, and changes nothing', async () => {
    const { order, items } = await stuckOrder(['succeeded', 'unknown']);
    const store = new DrizzleReviewStore(db);

    // The admin loads the page; then the recovery sweep settles the item.
    const loaded = await store.loadForReview(order.id);
    await db.update(orderItems).set({ status: 'failed' }).where(eq(orderItems.id, items[1]!.id));

    const { planReview } = await import('@levelup/engine');
    const planned = planReview(loaded!, { kind: 'mark_item_delivered', itemId: items[1]!.id });
    if (!planned.ok) throw new Error('expected a plan');

    await expect(store.applyReview(planned.plan, adminId)).rejects.toThrow(/changed while you were reviewing/);

    const after = await reload(order.id);
    expect(after.order.status).toBe('needs_review'); // rolled back with the item
    expect(after.items[1]!.status).toBe('failed');
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });
});

describe.skipIf(!PG_AVAILABLE)('refunds', () => {
  it('flags, then closes, with both steps audited', async () => {
    const { order } = await stuckOrder(['failed']);

    await act(order.id, { kind: 'flag_refund', note: 'Cuenta de Free Fire suspendida' });
    expect((await reload(order.id)).order.status).toBe('refund_required');

    await act(order.id, { kind: 'refund_done', note: 'SPEI $1,530 ref 998877' });
    expect((await reload(order.id)).order.status).toBe('cancelled');

    const actions = (await db.select().from(auditLog)).map((a) => a.action).sort();
    expect(actions).toEqual(['review.refund_done', 'review.refund_flagged']);
  });
});
