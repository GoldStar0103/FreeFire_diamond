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
import { createOrder, LEVEL_PASS_REWARD_COMBO_KEY } from '@levelup/engine';
import { ProviderSimulator, type ProviderProduct, type UsdTenK } from '@levelup/provider';
import { createDb, type Database } from '../index.js';
import {
  campaigns,
  comboItems,
  combos,
  baseProducts,
  financialLedgerEntries,
  itemOrderDetails,
  orderItems,
  orders,
  payments,
} from '../schema.js';
import { DrizzleCatalogSyncStore } from './catalog-sync-store.js';
import { DrizzleOrderingStore } from './ordering-store.js';
import { saveFxRate } from './payment-settings.js';
import { mexicoCityDayRange } from './mexico-city-time.js';
import { syncCatalog } from '@levelup/engine';
import { getAccountingSummary, getItemSalesBreakdown } from './accounting-queries.js';

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
  await syncCatalog({ store: new DrizzleCatalogSyncStore(db), provider, providerName: 'recargas_america' });

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
    method: 'card' | 'transfer_manual' | 'spei' | 'oxxo';
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

/**
 * A Level Pass reward order, inserted directly rather than through
 * `createOrder` — it has no real combo, no payment, and a real recharge
 * cost against a $0 price, exactly what `createRewardOrder` produces.
 */
async function seedCompletedRewardOrder(playerId: string, completedAt: Date, costUsd: string) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `LU-REWARD-${playerId}`,
      playerId,
      comboId: null,
      comboKey: LEVEL_PASS_REWARD_COMBO_KEY,
      comboSnapshot: { name: 'Recompensa Level Pass' },
      priceMxnCents: 0,
      status: 'completed',
      completedAt,
      createdAt: completedAt,
    })
    .returning();
  await db.insert(orderItems).values({
    orderId: order!.id,
    sequence: 0,
    providerProductId: 'd100',
    diamondsBase: 100,
    costUsd,
    status: 'succeeded',
  });
  return order!;
}

/**
 * A completed RocketPass item order, inserted directly like
 * `seedCompletedRewardOrder` above — `createItemOrder`'s own suite already
 * covers the engine logic, this just needs a realistic completed row with a
 * frozen `item_order_details` cost/price snapshot (MXN cents, no fxRate
 * involved, unlike a diamond order's `costUsd`).
 */
async function seedCompletedItemOrder(
  playerId: string,
  opts: {
    completedAt: Date;
    itemSku?: string;
    itemName?: string;
    quantity?: number;
    unitPriceMxnCents: number;
    unitCostMxnCents: number;
    method: 'card' | 'transfer_manual';
    gateway: string | null;
    amountReceivedCents: number;
  },
) {
  const quantity = opts.quantity ?? 1;
  const itemSku = opts.itemSku ?? 'crate';
  const itemName = opts.itemName ?? 'Evo Crate';
  const priceMxnCents = opts.unitPriceMxnCents * quantity;

  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `LU-ITEM-${playerId}`,
      playerId,
      orderType: 'item',
      comboId: null,
      comboKey: null,
      comboSnapshot: { name: itemName, advertisedDiamonds: 0 },
      priceMxnCents,
      status: 'completed',
      completedAt: opts.completedAt,
      createdAt: opts.completedAt,
    })
    .returning();

  await db.insert(itemOrderDetails).values({
    orderId: order!.id,
    itemSku,
    itemNameSnapshot: itemName,
    quantity,
    region: 'US',
    unitPriceSnapshotCents: opts.unitPriceMxnCents,
    unitCostCentsSnapshot: opts.unitCostMxnCents,
    fulfillmentStatus: 'delivered',
  });

  await db.insert(payments).values({
    orderId: order!.id,
    method: opts.method,
    status: 'paid',
    gateway: opts.gateway,
    amountExpectedCents: opts.amountReceivedCents,
    amountReceivedCents: opts.amountReceivedCents,
    paidAt: opts.completedAt,
  });

  return order!;
}

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(
    raw`TRUNCATE orders, order_items, item_order_details, payments, combo_items, combos, campaigns,
        base_products, financial_ledger_entries, seasons RESTART IDENTITY CASCADE`,
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
    expect(summary.totalsByMethod).toEqual([
      { method: 'card', gateway: 'stripe', totalCents: 10_000, count: 1 },
    ]);
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0]).toMatchObject({
      orderNumber: order.orderNumber,
      comboName: 'Test Combo',
      priceMxnCents: 10_000,
      paymentMethod: 'card',
      paymentGateway: 'stripe',
      // 10,000 - 3,000 cost - 766 estimated fee — an estimate here only
      // because the fee itself is an estimate for card payments.
      netProfitCents: 10_000 - 3_000 - 766,
    });
  });

  it('excludes a completed Level Pass reward order from every figure — it is not a sale', async () => {
    const saleOrder = await placeOrder('1111111111');
    const inRange = new Date('2026-09-14T18:00:00Z');
    await completeOrder(saleOrder.id, {
      completedAt: inRange,
      costUsd: '1.5000',
      method: 'card',
      gateway: 'stripe',
      amountReceivedCents: 10_000,
    });
    // A real recharge cost, zero price — exactly what a granted reward looks
    // like. If this were counted, it would drag net sales down by its cost
    // with no corresponding revenue, and inflate the completed-order count.
    await seedCompletedRewardOrder('2222222222', inRange, '1.0000');

    const range = mexicoCityDayRange(inRange);
    const summary = await getAccountingSummary(db, range);

    expect(summary.grossSalesCents).toBe(10_000);
    expect(summary.recargaCostCents).toBe(3_000); // only the real sale's cost
    expect(summary.orderCounts).toEqual({ completed: 1, pending: 0, cancelled: 0 });
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0]?.orderNumber).toBe(saleOrder.orderNumber);
  });

  it('keeps a Stripe SPEI sale and a Mercado Pago SPEI sale in separate buckets, not merged under one "spei"', async () => {
    // Real gap found 2026-09-27: SPEI moved from Stripe to Mercado Pago, but
    // totalsByMethod used to group by method alone — a Mercado Pago sale
    // would have silently pooled into the same bucket as older Stripe ones.
    const stripeOrder = await placeOrder('8888888881');
    const mpOrder = await placeOrder('8888888882');
    const inRange = new Date('2026-09-14T18:00:00Z');

    await completeOrder(stripeOrder.id, {
      completedAt: inRange,
      costUsd: '1.0000',
      method: 'spei',
      gateway: 'stripe',
      amountReceivedCents: 10_000,
    });
    await completeOrder(mpOrder.id, {
      completedAt: inRange,
      costUsd: '1.0000',
      method: 'spei',
      gateway: 'mercadopago',
      amountReceivedCents: 10_000,
    });

    const summary = await getAccountingSummary(db, mexicoCityDayRange(inRange));

    expect(summary.totalsByMethod).toEqual(
      expect.arrayContaining([
        { method: 'spei', gateway: 'stripe', totalCents: 10_000, count: 1 },
        { method: 'spei', gateway: 'mercadopago', totalCents: 10_000, count: 1 },
      ]),
    );
    expect(summary.totalsByMethod).toHaveLength(2);
  });

  it('charges no estimated fee for the manual transfer flow, and reports an exact net profit', async () => {
    const order = await placeOrder('2222222222');
    const inRange = new Date('2026-09-14T18:00:00Z');
    await completeOrder(order.id, {
      completedAt: inRange,
      costUsd: '1.0000', // $1.00 USD * 20 = $20.00 MXN = 2000 cents
      method: 'transfer_manual',
      gateway: null,
      amountReceivedCents: 10_000,
    });

    const summary = await getAccountingSummary(db, mexicoCityDayRange(inRange));
    expect(summary.estimatedFeeCents).toBe(0);
    // No processing fee on this method, so this is exact, not an estimate.
    expect(summary.movements[0]?.netProfitCents).toBe(10_000 - 2_000);
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
    // Never silently treated as zero cost — that would overstate this order's
    // profit rather than admit it isn't known.
    expect(summary.movements[0]?.netProfitCents).toBeNull();
  });

  it('includes a RocketPass item order\'s cost in recargaCostCents and its real profit in the movement row', async () => {
    // Real bug this test guards against: item orders have no `order_items`
    // row, so before `getSalesTotals` learned to read `item_order_details`,
    // their revenue was counted in grossSalesCents but their cost was
    // dropped entirely — overstating net profit by the full cost of every
    // completed item order.
    const inRange = new Date('2026-09-14T18:00:00Z');
    const itemOrder = await seedCompletedItemOrder('9999999999', {
      completedAt: inRange,
      unitPriceMxnCents: 2_100,
      unitCostMxnCents: 1_500,
      quantity: 2, // price 4,200, cost 3,000
      method: 'transfer_manual',
      gateway: null,
      amountReceivedCents: 4_200,
    });

    const summary = await getAccountingSummary(db, mexicoCityDayRange(inRange));

    expect(summary.grossSalesCents).toBe(4_200);
    expect(summary.recargaCostCents).toBe(3_000);
    expect(summary.costDataIncomplete).toBe(false);
    expect(summary.netSalesCents).toBe(4_200 - 3_000); // no fee on manual transfer
    expect(summary.movements).toHaveLength(1);
    expect(summary.movements[0]).toMatchObject({
      orderNumber: itemOrder.orderNumber,
      comboName: 'Evo Crate',
      priceMxnCents: 4_200,
      netProfitCents: 4_200 - 3_000,
    });
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

/**
 * The reward/adjustment half of the P&L. Sales profit is only "profit before
 * rewards" — what the spec calls real net profit also subtracts what the
 * Level Pass gave away, which lives in `financial_ledger_entries`.
 */
describe.skipIf(!PG_AVAILABLE)('getAccountingSummary — real net profit', () => {
  const DAY = new Date('2026-09-14T18:00:00Z');

  /** One sale: $100 paid by transfer (no gateway fee), $30 MXN of recharge cost. */
  async function seedOneSale(completedAt = DAY) {
    const order = await placeOrder('1111111111');
    await completeOrder(order.id, {
      completedAt,
      costUsd: '1.5000',
      method: 'transfer_manual',
      gateway: null,
      amountReceivedCents: 10_000,
    });
    return 10_000 - 3_000; // gross - cost, no fee on a manual transfer
  }

  async function seedLedger(
    entryType: 'level_pass_reward' | 'giveaway_prize' | 'manual_expense' | 'manual_income',
    amountCents: number,
    occurredAt = DAY,
  ) {
    await db.insert(financialLedgerEntries).values({ entryType, amountCents, occurredAt });
  }

  it('subtracts a granted Level Pass reward from real net profit', async () => {
    const profitBeforeRewards = await seedOneSale();
    await seedLedger('level_pass_reward', -1_200); // the ledger stores expenses negative

    const summary = await getAccountingSummary(db, mexicoCityDayRange(DAY));

    expect(summary.estimatedProfitCents).toBe(profitBeforeRewards);
    // Reported as a positive cost, the same way round as recargaCostCents.
    expect(summary.levelPassRewardCostCents).toBe(1_200);
    expect(summary.realNetProfitCents).toBe(profitBeforeRewards - 1_200);
  });

  it('subtracts a delivered giveaway prize from real net profit', async () => {
    const profitBeforeRewards = await seedOneSale();
    await seedLedger('giveaway_prize', -75_000);

    const summary = await getAccountingSummary(db, mexicoCityDayRange(DAY));

    expect(summary.giveawayPrizeCostCents).toBe(75_000);
    expect(summary.realNetProfitCents).toBe(profitBeforeRewards - 75_000);
  });

  it('applies manual expenses and manual income', async () => {
    const profitBeforeRewards = await seedOneSale();
    await seedLedger('manual_expense', -500);
    await seedLedger('manual_income', 250);

    const summary = await getAccountingSummary(db, mexicoCityDayRange(DAY));

    expect(summary.otherExpensesCents).toBe(500);
    expect(summary.manualIncomeCents).toBe(250);
    expect(summary.realNetProfitCents).toBe(profitBeforeRewards - 500 + 250);
  });

  it('sums several rewards granted on the same day', async () => {
    const profitBeforeRewards = await seedOneSale();
    await seedLedger('level_pass_reward', -1_200);
    await seedLedger('level_pass_reward', -4_000);

    const summary = await getAccountingSummary(db, mexicoCityDayRange(DAY));

    expect(summary.levelPassRewardCostCents).toBe(5_200);
    expect(summary.realNetProfitCents).toBe(profitBeforeRewards - 5_200);
  });

  it('ignores ledger rows outside the range — a reward is dated when it was granted', async () => {
    const profitBeforeRewards = await seedOneSale();
    await seedLedger('level_pass_reward', -1_200, new Date('2026-09-13T18:00:00Z'));

    const summary = await getAccountingSummary(db, mexicoCityDayRange(DAY));

    expect(summary.levelPassRewardCostCents).toBe(0);
    expect(summary.realNetProfitCents).toBe(profitBeforeRewards);
  });

  it('reports net margin against gross sales, and null when nothing was sold', async () => {
    const empty = await getAccountingSummary(db, mexicoCityDayRange(DAY));
    expect(empty.netMarginPct).toBeNull();

    await seedOneSale();
    await seedLedger('level_pass_reward', -1_000);

    const summary = await getAccountingSummary(db, mexicoCityDayRange(DAY));
    // (7,000 − 1,000) / 10,000 = 60%
    expect(summary.netMarginPct).toBeCloseTo(60, 5);
  });

  it('can go negative when the rewards granted outweigh the day’s profit', async () => {
    const profitBeforeRewards = await seedOneSale();
    await seedLedger('level_pass_reward', -20_000);

    const summary = await getAccountingSummary(db, mexicoCityDayRange(DAY));

    expect(summary.realNetProfitCents).toBe(profitBeforeRewards - 20_000);
    expect(summary.realNetProfitCents).toBeLessThan(0);
  });
});

describe.skipIf(!PG_AVAILABLE)('getItemSalesBreakdown', () => {
  const DAY = new Date('2026-09-14T18:00:00Z');

  it('sums gross/cost/profit for item orders only, ignoring the diamond combo seeded by beforeEach', async () => {
    await placeOrder('1111111111'); // a diamond order sitting around, never completed — must not leak in
    await seedCompletedItemOrder('9999999999', {
      completedAt: DAY,
      unitPriceMxnCents: 2_100,
      unitCostMxnCents: 1_500,
      quantity: 2,
      method: 'transfer_manual',
      gateway: null,
      amountReceivedCents: 4_200,
    });

    const report = await getItemSalesBreakdown(db, mexicoCityDayRange(DAY));

    expect(report.summary).toMatchObject({
      grossSalesCents: 4_200,
      costCents: 3_000,
      estimatedFeeCents: 0,
      netProfitCents: 1_200,
      unitsSold: 2,
      orderCount: 1,
    });
  });

  it('breaks totals down per SKU, combining several orders of the same item', async () => {
    await seedCompletedItemOrder('1010101010', {
      completedAt: DAY,
      itemSku: 'crate',
      itemName: 'Evo Crate',
      unitPriceMxnCents: 2_100,
      unitCostMxnCents: 1_500,
      quantity: 1,
      method: 'transfer_manual',
      gateway: null,
      amountReceivedCents: 2_100,
    });
    await seedCompletedItemOrder('2020202020', {
      completedAt: DAY,
      itemSku: 'crate',
      itemName: 'Evo Crate',
      unitPriceMxnCents: 2_100,
      unitCostMxnCents: 1_500,
      quantity: 1,
      method: 'transfer_manual',
      gateway: null,
      amountReceivedCents: 2_100,
    });
    await seedCompletedItemOrder('3030303030', {
      completedAt: DAY,
      itemSku: 'token',
      itemName: 'Evo Shard',
      unitPriceMxnCents: 500,
      unitCostMxnCents: 300,
      quantity: 5,
      method: 'transfer_manual',
      gateway: null,
      amountReceivedCents: 2_500,
    });

    const report = await getItemSalesBreakdown(db, mexicoCityDayRange(DAY));

    expect(report.bySku).toHaveLength(2);
    const crate = report.bySku.find((r) => r.itemSku === 'crate');
    const token = report.bySku.find((r) => r.itemSku === 'token');
    expect(crate).toMatchObject({
      itemName: 'Evo Crate',
      unitsSold: 2,
      orderCount: 2,
      grossRevenueCents: 4_200,
      costCents: 3_000,
      profitCents: 1_200,
    });
    expect(token).toMatchObject({
      itemName: 'Evo Shard',
      unitsSold: 5,
      orderCount: 1,
      grossRevenueCents: 2_500,
      costCents: 1_500,
      profitCents: 1_000,
    });
  });

  it('excludes an item order completed outside the requested range', async () => {
    await seedCompletedItemOrder('4040404040', {
      completedAt: new Date('2026-09-15T18:00:00Z'),
      unitPriceMxnCents: 2_100,
      unitCostMxnCents: 1_500,
      method: 'transfer_manual',
      gateway: null,
      amountReceivedCents: 2_100,
    });

    const report = await getItemSalesBreakdown(db, mexicoCityDayRange(DAY));
    expect(report.summary.orderCount).toBe(0);
    expect(report.bySku).toHaveLength(0);
  });

  it('estimates a card processing fee the same way getAccountingSummary does', async () => {
    await seedCompletedItemOrder('5050505050', {
      completedAt: DAY,
      unitPriceMxnCents: 10_000,
      unitCostMxnCents: 1_500,
      method: 'card',
      gateway: 'stripe',
      amountReceivedCents: 10_000,
    });

    const report = await getItemSalesBreakdown(db, mexicoCityDayRange(DAY));
    // 3.6% of $100 (360) + $3.00 fixed (300) = 660, * 1.16 IVA = 765.6 -> 766
    expect(report.summary.estimatedFeeCents).toBe(766);
    expect(report.summary.netProfitCents).toBe(10_000 - 1_500 - 766);
  });
});
