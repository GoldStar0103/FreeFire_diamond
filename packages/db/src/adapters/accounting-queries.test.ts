/**
 * `getAccountingSummary` against real Postgres.
 *
 * Orders are created through the real `createOrder` engine call (so recipe/
 * snapshot/payment-row wiring is real), then patched directly to a completed,
 * paid state with concrete cost/payment figures — the same pragmatic style
 * `admin-queries.test.ts` already uses for its own dashboard-stats tests,
 * since running the full provider-fulfilment flow just to get a `completed`
 * order would test the fulfilment engine again, not this report.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createOrder } from '@levelup/engine';
import { ProviderSimulator, type ProviderProduct, type UsdTenK } from '@levelup/provider';
import { createDb, type Database } from '../index.js';
import { campaigns, comboItems, combos, baseProducts, orderItems, orders, payments } from '../schema.js';
import { DrizzleCatalogSyncStore } from './catalog-sync-store.js';
import { DrizzleOrderingStore } from './ordering-store.js';
import { saveFxRate } from './payment-settings.js';
import { mexicoCityDayRange } from './mexico-city-time.js';
import { syncCatalog } from '@levelup/engine';
import { getAccountingSummary } from './accounting-queries.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_accounting_test';

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

const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;

/** One combo, one denomination, price $100 MXN (10,000 cents), for round numbers. */
async function seedOneCombo() {
  const provider = new ProviderSimulator();
  provider.programCatalog([
    {
      providerProductId: 'd100',
      endpointKind: 'pins_recharge' as const,
      name: 'Free Fire 100 Diamonds',
      sku: 'FF100',
      diamondsBase: 100,
      costUsd: usd(1),
      requiresServerId: false,
      canValidate: true,
      raw: {},
    } satisfies ProviderProduct,
  ]);
  await syncCatalog({ store: new DrizzleCatalogSyncStore(db), provider });

  const [product] = await db.select().from(baseProducts);
  const [campaign] = await db.insert(campaigns).values({ key: 'test', name: 'TEST' }).returning();
  const [combo] = await db
    .insert(combos)
    .values({
      campaignId: campaign!.id,
      key: 'test_combo',
      name: 'Test Combo',
      priceMxnCents: 10_000,
      advertisedDiamonds: 100,
      active: true,
    })
    .returning();
  await db.insert(comboItems).values({ comboId: combo!.id, baseProductId: product!.id, sequence: 0 });
}

async function placeOrder(playerId: string) {
  const result = await createOrder(
    { store: new DrizzleOrderingStore(db) },
    { comboKey: 'test_combo', playerId, paymentMethod: 'transfer_manual', source: 'admin' },
  );
  if (!result.ok) throw new Error(`seed order failed: ${result.failure.code}`);
  return result.order;
}

/** Patches an order straight to completed+paid with a concrete cost and fee-relevant payment. */
async function completeOrder(
  orderId: string,
  opts: {
    completedAt: Date;
    costUsd: string;
    method: 'card' | 'transfer_manual';
    gateway: string | null;
    amountReceivedCents: number;
  },
) {
  await db
    .update(orders)
    // createdAt is also pinned to the test's controlled instant — orderCounts
    // buckets by createdAt, and a real order's createdAt/completedAt are
    // always close together, so this keeps the fixture internally coherent
    // instead of leaving createdAt at the real wall-clock time `createOrder`
    // used (which would fall outside a fixed historical test range).
    .set({ status: 'completed', completedAt: opts.completedAt, createdAt: opts.completedAt })
    .where(eq(orders.id, orderId));
  await db.update(orderItems).set({ costUsd: opts.costUsd }).where(eq(orderItems.orderId, orderId));
  await db.insert(payments).values({
    orderId,
    method: opts.method,
    status: 'paid',
    gateway: opts.gateway,
    amountExpectedCents: opts.amountReceivedCents,
    amountReceivedCents: opts.amountReceivedCents,
    paidAt: opts.completedAt,
  });
}

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(
    raw`TRUNCATE orders, order_items, payments, combo_items, combos, campaigns, base_products RESTART IDENTITY CASCADE`,
  );
  await seedOneCombo();
  await saveFxRate(db, 20); // round number for easy assertions
});

describe.skipIf(!PG_AVAILABLE)('getAccountingSummary', () => {
  it('sums gross sales, recharge cost (converted to MXN), and an estimated card fee', async () => {
    const order = await placeOrder('1111111111');
    const inRange = new Date('2026-09-14T18:00:00Z'); // midday Mexico City on the 14th
    await completeOrder(order.id, {
      completedAt: inRange,
      costUsd: '1.5000', // $1.50 USD * 20 = $30.00 MXN = 3000 cents
      method: 'card',
      gateway: 'stripe',
      amountReceivedCents: 10_000,
    });

    const range = mexicoCityDayRange(inRange);
    const summary = await getAccountingSummary(db, range);

    expect(summary.grossSalesCents).toBe(10_000);
    expect(summary.recargaCostCents).toBe(3_000);
    expect(summary.costDataIncomplete).toBe(false);
    // 3.6% of $100 (360) + $3.00 fixed (300) = 660, * 1.16 IVA = 765.6 -> 766
    expect(summary.estimatedFeeCents).toBe(766);
    expect(summary.netSalesCents).toBe(10_000 - 3_000 - 766);
    expect(summary.orderCounts).toEqual({ completed: 1, pending: 0, cancelled: 0 });
    expect(summary.totalsByMethod).toEqual([{ method: 'card', totalCents: 10_000, count: 1 }]);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0]).toMatchObject({
      orderNumber: order.orderNumber,
      comboName: 'Test Combo',
      priceMxnCents: 10_000,
      paymentMethod: 'card',
      paymentGateway: 'stripe',
    });
  });

  it('charges no estimated fee for the manual transfer flow', async () => {
    const order = await placeOrder('2222222222');
    const inRange = new Date('2026-09-14T18:00:00Z');
    await completeOrder(order.id, {
      completedAt: inRange,
      costUsd: '1.0000',
      method: 'transfer_manual',
      gateway: null,
      amountReceivedCents: 10_000,
    });

    const summary = await getAccountingSummary(db, mexicoCityDayRange(inRange));
    expect(summary.estimatedFeeCents).toBe(0);
  });

  it('excludes an order completed outside the requested range', async () => {
    const order = await placeOrder('3333333333');
    // 2026-09-15T18:00Z is a different Mexico City day than the range below.
    await completeOrder(order.id, {
      completedAt: new Date('2026-09-15T18:00:00Z'),
      costUsd: '1.0000',
      method: 'card',
      gateway: 'stripe',
      amountReceivedCents: 10_000,
    });

    const summary = await getAccountingSummary(db, mexicoCityDayRange(new Date('2026-09-14T18:00:00Z')));
    expect(summary.grossSalesCents).toBe(0);
    expect(summary.movements).toHaveLength(0);
  });

  it('flags incomplete cost data instead of silently under-reporting', async () => {
    const order = await placeOrder('4444444444');
    const inRange = new Date('2026-09-14T18:00:00Z');
    await db
      .update(orders)
      .set({ status: 'completed', completedAt: inRange })
      .where(eq(orders.id, order.id));
    await db.insert(payments).values({
      orderId: order.id,
      method: 'card',
      status: 'paid',
      gateway: 'stripe',
      amountExpectedCents: 10_000,
      amountReceivedCents: 10_000,
      paidAt: inRange,
    });
    // costUsd is normally copied from the catalog at order-creation time
    // (ordering-store.ts) — genuinely null only for the rarer case of a
    // product whose cost was never captured. Force that here explicitly.
    await db.update(orderItems).set({ costUsd: null }).where(eq(orderItems.orderId, order.id));

    const summary = await getAccountingSummary(db, mexicoCityDayRange(inRange));
    expect(summary.costDataIncomplete).toBe(true);
    expect(summary.recargaCostCents).toBe(0);
  });

  it('buckets order counts by creation date and by the client\'s three words', async () => {
    const inRange = new Date('2026-09-14T18:00:00Z');

    const completed = await placeOrder('5555555555');
    await completeOrder(completed.id, {
      completedAt: inRange,
      costUsd: '1.0000',
      method: 'card',
      gateway: 'stripe',
      amountReceivedCents: 10_000,
    });

    const pending = await placeOrder('6666666666'); // stays pending_payment
    await db.update(orders).set({ createdAt: inRange }).where(eq(orders.id, pending.id));

    const cancelled = await placeOrder('7777777777');
    await db
      .update(orders)
      .set({ status: 'cancelled', createdAt: inRange })
      .where(eq(orders.id, cancelled.id));

    // All three orders' createdAt is pinned to the same instant above (real
    // `createOrder` calls otherwise stamp real wall-clock time, which would
    // fall outside this fixed historical range) — orderCounts buckets by
    // createdAt, not completedAt.
    const summary = await getAccountingSummary(db, mexicoCityDayRange(inRange));
    expect(summary.orderCounts).toEqual({ completed: 1, pending: 1, cancelled: 1 });
  });
});
