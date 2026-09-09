/**
 * Recovery queries against real Postgres.
 *
 * These are time-window queries, so they cannot be meaningfully tested against
 * a fake — `make_interval`, `now()` and the age arithmetic are the behaviour
 * under test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { baseProducts, campaigns, combos, orderItems, orders, payments } from '../schema.js';
import { DrizzleRecoveryStore } from './recovery-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_recovery_test';

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
let productId: string;

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
    raw`TRUNCATE orders, order_items, combos, campaigns, base_products RESTART IDENTITY CASCADE`,
  );
  const [product] = await db
    .insert(baseProducts)
    .values({
      providerProductId: 'd5600',
      endpointKind: 'pins_recharge',
      name: 'Free Fire 5600',
      diamondsBase: 5600,
      costUsd: '27.5000',
    })
    .returning();
  productId = product!.id;
});

type ItemStatus = 'queued' | 'sending' | 'provider_pending' | 'succeeded';

/** Insert one order with one item, positioned at a chosen age. */
async function seedItem(options: {
  orderNumber: string;
  itemStatus: ItemStatus;
  ageSeconds: number;
  orderStatus?: 'payment_confirmed' | 'processing' | 'cancelled' | 'refund_required';
  costUsd?: string | null;
  walletBeforeUsd?: string | null;
  providerReference?: string | null;
}) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: options.orderNumber,
      playerId: '7288567050',
      comboKey: 'mega_prime_48k',
      comboSnapshot: { name: 'Mega Prime 48k' },
      priceMxnCents: 585_000,
      status: options.orderStatus ?? 'processing',
    })
    .returning();

  const stamp = raw`now() - make_interval(secs => ${options.ageSeconds})`;

  const [item] = await db
    .insert(orderItems)
    .values({
      orderId: order!.id,
      sequence: 0,
      baseProductId: productId,
      providerProductId: 'd5600',
      diamondsBase: 5600,
      costUsd: options.costUsd === undefined ? '27.5000' : options.costUsd,
      status: options.itemStatus,
      attemptCount: 1,
      providerReference: options.providerReference ?? null,
      walletBeforeUsd: options.walletBeforeUsd ?? null,
      // Both timestamps set to the same age; each query reads only the one it cares about.
      sentAt: stamp,
      settledAt: stamp,
    })
    .returning();

  return { orderId: order!.id, itemId: item!.id };
}

/** An order with a payment, positioned relative to its deadline. */
async function seedPayment(options: {
  orderNumber: string;
  paymentStatus: 'pending' | 'under_review' | 'paid';
  orderStatus?: 'pending_payment' | 'payment_confirmed' | 'cancelled';
  /** Negative is overdue. Null leaves the column empty, as pre-existing rows are. */
  expiresInSeconds: number | null;
  comboKey?: string;
}) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: options.orderNumber,
      playerId: '7288567050',
      comboKey: options.comboKey ?? 'mega_10',
      comboSnapshot: { name: 'Mega Oferta 110' },
      priceMxnCents: 1_000,
      status: options.orderStatus ?? 'pending_payment',
    })
    .returning();

  const [payment] = await db
    .insert(payments)
    .values({
      orderId: order!.id,
      method: 'transfer_manual',
      status: options.paymentStatus,
      amountExpectedCents: 1_000,
      expiresAt:
        options.expiresInSeconds === null
          ? null
          : raw`now() + make_interval(secs => ${options.expiresInSeconds})`,
    })
    .returning();

  return { orderId: order!.id, paymentId: payment!.id };
}

describe.skipIf(!PG_AVAILABLE)('findOverduePayments', () => {
  const store = () => new DrizzleRecoveryStore(db);

  it('finds an unpaid order past its deadline', async () => {
    const { orderId } = await seedPayment({
      orderNumber: 'LU-1',
      paymentStatus: 'pending',
      expiresInSeconds: -60,
    });

    const found = await store().findOverduePayments(new Date(), 25);
    expect(found).toHaveLength(1);
    expect(found[0]?.orderId).toBe(orderId);
    expect(found[0]?.orderNumber).toBe('LU-1');
  });

  it('leaves an order alone before its deadline', async () => {
    await seedPayment({ orderNumber: 'LU-1', paymentStatus: 'pending', expiresInSeconds: 3600 });
    expect(await store().findOverduePayments(new Date(), 25)).toHaveLength(0);
  });

  it('NEVER expires a payment under review, however overdue', async () => {
    // The single most important condition here. `under_review` means a
    // comprobante was uploaded — somebody has already sent real money and is
    // waiting on the panel. Expiring one of these cancels a paid order.
    await seedPayment({
      orderNumber: 'LU-1',
      paymentStatus: 'under_review',
      expiresInSeconds: -86_400,
    });
    expect(await store().findOverduePayments(new Date(), 25)).toHaveLength(0);
  });

  it('never expires a payment already paid', async () => {
    await seedPayment({
      orderNumber: 'LU-1',
      paymentStatus: 'paid',
      orderStatus: 'payment_confirmed',
      expiresInSeconds: -86_400,
    });
    expect(await store().findOverduePayments(new Date(), 25)).toHaveLength(0);
  });

  it('ignores rows written before payments had deadlines', async () => {
    // A null expires_at is unknown, not infinitely overdue.
    await seedPayment({ orderNumber: 'LU-1', paymentStatus: 'pending', expiresInSeconds: null });
    expect(await store().findOverduePayments(new Date(), 25)).toHaveLength(0);
  });

  it('skips an order that is no longer pending_payment', async () => {
    await seedPayment({
      orderNumber: 'LU-1',
      paymentStatus: 'pending',
      orderStatus: 'cancelled',
      expiresInSeconds: -60,
    });
    expect(await store().findOverduePayments(new Date(), 25)).toHaveLength(0);
  });

  it('respects the batch size and takes the most overdue first', async () => {
    await seedPayment({ orderNumber: 'LU-1', paymentStatus: 'pending', expiresInSeconds: -60 });
    await seedPayment({
      orderNumber: 'LU-2',
      paymentStatus: 'pending',
      expiresInSeconds: -600,
      comboKey: 'pack_insano',
    });

    const found = await store().findOverduePayments(new Date(), 1);
    expect(found).toHaveLength(1);
    expect(found[0]?.orderNumber).toBe('LU-2');
  });
});

describe.skipIf(!PG_AVAILABLE)('expirePayment', () => {
  it('frees a blocked Mega Oferta slot', async () => {
    // The whole point. The one-per-player index counts every order that is not
    // cancelled or expired, so an abandoned attempt used to lock a customer out
    // of the entry offer permanently.
    const { orderId, paymentId } = await seedPayment({
      orderNumber: 'LU-1',
      paymentStatus: 'pending',
      expiresInSeconds: -60,
    });

    await new DrizzleRecoveryStore(db).expirePayment({ orderId, paymentId });

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(order?.status).toBe('payment_expired');

    // The index permits a second attempt now.
    await expect(
      seedPayment({ orderNumber: 'LU-2', paymentStatus: 'pending', expiresInSeconds: 3600 }),
    ).resolves.toBeDefined();
  });
});

describe.skipIf(!PG_AVAILABLE)('findPendingProviderItems', () => {
  it('finds an item that has been PENDING long enough', async () => {
    const { itemId } = await seedItem({
      orderNumber: 'LU-1',
      itemStatus: 'provider_pending',
      ageSeconds: 120,
      providerReference: 'REF-1',
    });

    const found = await new DrizzleRecoveryStore(db).findPendingProviderItems(30_000, 25);

    expect(found).toHaveLength(1);
    expect(found[0]?.itemId).toBe(itemId);
    expect(found[0]?.providerReference).toBe('REF-1');
    expect(found[0]?.costUsd).toBe(275_000);
    // ~120s, allowing for execution time.
    expect(found[0]?.ageMs).toBeGreaterThan(119_000);
    expect(found[0]?.ageMs).toBeLessThan(125_000);
  });

  it('leaves a freshly dispatched item alone', async () => {
    // The live run may still be handling this one; racing it is the bug the
    // age window exists to prevent.
    await seedItem({ orderNumber: 'LU-1', itemStatus: 'provider_pending', ageSeconds: 2 });

    expect(await new DrizzleRecoveryStore(db).findPendingProviderItems(30_000, 25)).toHaveLength(0);
  });

  it('ignores items in any other state', async () => {
    await seedItem({ orderNumber: 'LU-1', itemStatus: 'succeeded', ageSeconds: 600 });
    await seedItem({ orderNumber: 'LU-2', itemStatus: 'queued', ageSeconds: 600 });

    expect(await new DrizzleRecoveryStore(db).findPendingProviderItems(30_000, 25)).toHaveLength(0);
  });

  it('skips abandoned orders', async () => {
    await seedItem({
      orderNumber: 'LU-1',
      itemStatus: 'provider_pending',
      ageSeconds: 600,
      orderStatus: 'cancelled',
    });
    await seedItem({
      orderNumber: 'LU-2',
      itemStatus: 'provider_pending',
      ageSeconds: 600,
      orderStatus: 'refund_required',
    });

    expect(await new DrizzleRecoveryStore(db).findPendingProviderItems(30_000, 25)).toHaveLength(0);
  });

  it('skips items with no synced cost', async () => {
    await seedItem({
      orderNumber: 'LU-1',
      itemStatus: 'provider_pending',
      ageSeconds: 600,
      costUsd: null,
    });

    expect(await new DrizzleRecoveryStore(db).findPendingProviderItems(30_000, 25)).toHaveLength(0);
  });

  it('returns oldest first and respects the batch limit', async () => {
    await seedItem({ orderNumber: 'LU-new', itemStatus: 'provider_pending', ageSeconds: 60 });
    await seedItem({ orderNumber: 'LU-old', itemStatus: 'provider_pending', ageSeconds: 900 });
    await seedItem({ orderNumber: 'LU-mid', itemStatus: 'provider_pending', ageSeconds: 300 });

    const found = await new DrizzleRecoveryStore(db).findPendingProviderItems(30_000, 2);

    expect(found).toHaveLength(2);
    expect(found.map((i) => i.orderNumber)).toEqual(['LU-old', 'LU-mid']);
  });
});

describe.skipIf(!PG_AVAILABLE)('findStalledSendingItems', () => {
  it('finds an item a dead worker left mid-send', async () => {
    const { itemId } = await seedItem({
      orderNumber: 'LU-1',
      itemStatus: 'sending',
      ageSeconds: 300,
      walletBeforeUsd: '150.0000',
    });

    const found = await new DrizzleRecoveryStore(db).findStalledSendingItems(30_000, 25);

    expect(found).toHaveLength(1);
    expect(found[0]?.itemId).toBe(itemId);
    // The pre-call snapshot is the whole point — without it there is nothing
    // to reconcile the wallet against.
    expect(found[0]?.walletBeforeUsd).toBe(1_500_000);
    expect(found[0]?.attemptCount).toBe(1);
  });

  it('does not touch a call that is still in flight', async () => {
    await seedItem({ orderNumber: 'LU-1', itemStatus: 'sending', ageSeconds: 3 });

    expect(await new DrizzleRecoveryStore(db).findStalledSendingItems(30_000, 25)).toHaveLength(0);
  });

  it('surfaces a stalled item that has no wallet snapshot', async () => {
    // The poller escalates these rather than guessing; the query must still
    // return them so somebody finds out.
    await seedItem({
      orderNumber: 'LU-1',
      itemStatus: 'sending',
      ageSeconds: 300,
      walletBeforeUsd: null,
    });

    const found = await new DrizzleRecoveryStore(db).findStalledSendingItems(30_000, 25);
    expect(found).toHaveLength(1);
    expect(found[0]?.walletBeforeUsd).toBeNull();
  });

  it('does not confuse PENDING items with stalled sends', async () => {
    await seedItem({ orderNumber: 'LU-1', itemStatus: 'provider_pending', ageSeconds: 600 });

    expect(await new DrizzleRecoveryStore(db).findStalledSendingItems(30_000, 25)).toHaveLength(0);
  });
});

describe.skipIf(!PG_AVAILABLE)('inherited fulfilment behaviour', () => {
  it('still loads orders through the base store', async () => {
    const { orderId } = await seedItem({
      orderNumber: 'LU-1',
      itemStatus: 'queued',
      ageSeconds: 10,
    });

    const loaded = await new DrizzleRecoveryStore(db).loadOrder(orderId);
    expect(loaded?.items).toHaveLength(1);
    expect(loaded?.items[0]?.costUsd).toBe(275_000);
  });

  it('still refuses a non-dispatchable item', async () => {
    const { itemId } = await seedItem({
      orderNumber: 'LU-1',
      itemStatus: 'succeeded',
      ageSeconds: 10,
    });

    await expect(
      new DrizzleRecoveryStore(db).markItemSending(itemId, 1_500_000 as never),
    ).rejects.toThrow(/not in a dispatchable state/);
  });
});
