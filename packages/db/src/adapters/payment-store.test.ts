/**
 * The comprobante flow against real Postgres — from an unpaid order to one the
 * fulfilment worker will claim.
 *
 * This is the launch path: LevelUp keeps taking BBVA transfers and OXXO
 * deposits exactly as they do today, and approval here replaces the manual
 * WhatsApp back-and-forth. Conekta later calls the same code from a webhook.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { approvePayment, createOrder, expireUnpaid, rejectPayment } from '@levelup/engine';
import { createDb, type Database } from '../index.js';
import { auditLog, baseProducts, campaigns, comboItems, combos, orders, payments } from '../schema.js';
import { DrizzleOrderingStore } from './ordering-store.js';
import { DrizzlePaymentStore } from './payment-store.js';
import { DrizzleOrderQueue } from './order-queue.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_payment_test';

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

/** One paid-pending order for the $1,530 pack from the client's WhatsApp log. */
async function seedOrder() {
  const [campaign] = await db
    .insert(campaigns)
    .values({ key: 'mega_prime', name: 'PACKS MEGA PRIME' })
    .returning();
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
  const [combo] = await db
    .insert(combos)
    .values({
      campaignId: campaign!.id,
      key: 'mega_prime_12k',
      name: 'Mega Prime 12k +200',
      priceMxnCents: 153_000,
      advertisedDiamonds: 12_200,
    })
    .returning();
  await db.insert(comboItems).values([
    { comboId: combo!.id, baseProductId: product!.id, sequence: 0 },
    { comboId: combo!.id, baseProductId: product!.id, sequence: 1 },
  ]);

  const created = await createOrder(
    { store: new DrizzleOrderingStore(db) },
    {
      comboKey: 'mega_prime_12k',
      playerId: '7288567050',
      paymentMethod: 'transfer_manual',
      source: 'storefront',
    },
  );
  if (!created.ok) throw new Error(`seed failed: ${created.failure.code}`);

  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.orderNumber, created.order.orderNumber));
  return order!;
}

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(
    raw`TRUNCATE orders, order_items, payments, combo_items, combos, campaigns, base_products, audit_log RESTART IDENTITY CASCADE`,
  );
});

const store = () => new DrizzlePaymentStore(db);

describe.skipIf(!PG_AVAILABLE)('approving a comprobante', () => {
  it('makes the order claimable by the worker', async () => {
    const order = await seedOrder();

    // Before approval the worker must not see it.
    expect(await new DrizzleOrderQueue(db).claimNext(300_000)).toBeNull();

    const result = await approvePayment(
      { store: store() },
      { orderId: order.id, amountReceivedCents: 153_000, adminUserId: null },
    );
    expect(result.ok).toBe(true);

    const claimed = await new DrizzleOrderQueue(db).claimNext(300_000);
    expect(claimed?.orderNumber).toBe(order.orderNumber);
  });

  it('records payment and order state together', async () => {
    const order = await seedOrder();
    await approvePayment({ store: store() }, { orderId: order.id });

    const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id));
    const [updated] = await db.select().from(orders).where(eq(orders.id, order.id));

    expect(payment?.status).toBe('paid');
    expect(payment?.amountReceivedCents).toBe(153_000);
    expect(payment?.paidAt).toBeInstanceOf(Date);
    expect(updated?.status).toBe('payment_confirmed');
    expect(updated?.paidAt).toBeInstanceOf(Date);
  });

  it('writes an attributable audit entry', async () => {
    const order = await seedOrder();
    await approvePayment(
      { store: store() },
      { orderId: order.id, adminUserId: null, reference: 'BBVA-4152' },
    );

    const [entry] = await db.select().from(auditLog);
    expect(entry?.action).toBe('payment.approved');
    expect(entry?.entityId).toBe(order.id);
  });

  it('is idempotent under a double tap', async () => {
    const order = await seedOrder();

    const first = await approvePayment({ store: store() }, { orderId: order.id });
    const second = await approvePayment({ store: store() }, { orderId: order.id });

    expect(first).toMatchObject({ alreadyApproved: false });
    expect(second).toMatchObject({ ok: true, alreadyApproved: true });
    // One audit row, not two — the second call short-circuited.
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it('lets only one of two concurrent approvals through', async () => {
    const order = await seedOrder();

    // Both read `pending`, so neither short-circuits; the guarded UPDATE decides.
    const results = await Promise.allSettled([
      approvePayment({ store: store() }, { orderId: order.id }),
      approvePayment({ store: store() }, { orderId: order.id }),
    ]);

    const enqueued = results.filter(
      (r) => r.status === 'fulfilled' && r.value.ok && !r.value.alreadyApproved,
    );
    expect(enqueued).toHaveLength(1);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });
});

describe.skipIf(!PG_AVAILABLE)('amount mismatch', () => {
  it('flags a short payment and leaves the order unfulfillable', async () => {
    const order = await seedOrder();

    const result = await approvePayment(
      { store: store() },
      { orderId: order.id, amountReceivedCents: 100_000 },
    );

    expect(result).toMatchObject({ failure: { code: 'AMOUNT_MISMATCH' } });

    const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id));
    const [updated] = await db.select().from(orders).where(eq(orders.id, order.id));

    expect(payment?.status).toBe('amount_mismatch');
    expect(updated?.status).toBe('pending_payment');
    // Nothing ships until a human decides what the difference means.
    expect(await new DrizzleOrderQueue(db).claimNext(300_000)).toBeNull();
  });

  it('can be overridden deliberately, and says so in the audit trail', async () => {
    const order = await seedOrder();
    await approvePayment({ store: store() }, { orderId: order.id, amountReceivedCents: 152_000 });

    const result = await approvePayment(
      { store: store() },
      { orderId: order.id, amountReceivedCents: 152_000, acceptMismatch: true },
    );

    expect(result.ok).toBe(true);
    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toContain('payment.amount_mismatch');
    expect(actions).toContain('payment.approved_with_mismatch');
  });
});

describe.skipIf(!PG_AVAILABLE)('rejection and expiry', () => {
  it('cancels the order on rejection', async () => {
    const order = await seedOrder();

    await rejectPayment(
      { store: store() },
      { orderId: order.id, reason: 'Comprobante ilegible' },
    );

    const [updated] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(updated?.status).toBe('cancelled');
    expect(await new DrizzleOrderQueue(db).claimNext(300_000)).toBeNull();
  });

  it('refuses to reject money that already arrived', async () => {
    const order = await seedOrder();
    await approvePayment({ store: store() }, { orderId: order.id });

    expect(
      await rejectPayment({ store: store() }, { orderId: order.id, reason: 'oops' }),
    ).toMatchObject({ failure: { code: 'NOT_AWAITING_PAYMENT' } });

    const [updated] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(updated?.status).toBe('payment_confirmed');
  });

  it('expires an unpaid order past its window', async () => {
    const order = await seedOrder();
    await db
      .update(payments)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(payments.orderId, order.id));

    expect(await expireUnpaid({ store: store() }, order.id)).toEqual({ expired: true });

    const [updated] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(updated?.status).toBe('payment_expired');
  });

  it('leaves an already-paid order alone when the sweep runs', async () => {
    const order = await seedOrder();
    await db
      .update(payments)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(payments.orderId, order.id));
    await approvePayment({ store: store() }, { orderId: order.id, acceptMismatch: true });

    expect(await expireUnpaid({ store: store() }, order.id)).toEqual({ expired: false });

    const [updated] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(updated?.status).toBe('payment_confirmed');
  });
});
