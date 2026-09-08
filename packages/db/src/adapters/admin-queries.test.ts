/**
 * Admin read models against real Postgres.
 *
 * These drive the screens the client uses daily, so the fixtures are the real
 * September catalog rather than invented data — including the three combos
 * that under-deliver.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { approvePayment, createOrder, syncCatalog } from '@levelup/engine';
import { ProviderSimulator, type ProviderProduct, type UsdTenK } from '@levelup/provider';
import { createDb, type Database } from '../index.js';
import { campaigns, comboItems, combos, baseProducts, orderItems, orders, payments } from '../schema.js';
import { DrizzleCatalogSyncStore } from './catalog-sync-store.js';
import { DrizzleOrderingStore } from './ordering-store.js';
import { DrizzlePaymentStore } from './payment-store.js';
import {
  getDashboardStats,
  getOrderDetail,
  listCombosForAdmin,
  listOrders,
  listPendingApprovals,
} from './admin-queries.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_admin_test';

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
const ALL_SIX = [100, 310, 520, 1060, 2180, 5600];

const catalog = (): ProviderProduct[] =>
  ALL_SIX.map((d) => ({
    providerProductId: `d${d}`,
    endpointKind: 'pins_recharge' as const,
    name: `Free Fire ${d} Diamonds`,
    sku: `FF${d}`,
    diamondsBase: d,
    costUsd: usd(d / 200),
    requiresServerId: false,
    canValidate: true,
    raw: {},
  }));

/** Three real September combos: one healthy, one under-delivering, the $10 hook. */
async function seedCatalog() {
  const provider = new ProviderSimulator();
  provider.programCatalog(catalog());
  await syncCatalog({ store: new DrizzleCatalogSyncStore(db), provider });

  const products = await db.select().from(baseProducts);
  const byDenomination = new Map(products.map((p) => [p.diamondsBase, p.id]));

  const [campaign] = await db
    .insert(campaigns)
    .values({ key: 'sept', name: 'SUPER PACKS' })
    .returning();

  const specs = [
    { key: 'pack_insano', name: 'Pack Insano', price: 86_000, advertised: 7200, recipe: [5600, 1060], active: true },
    // Delivers 3,564 against 3,600 advertised — seeded inactive by the seeder.
    { key: 'pack_good', name: 'Pack Good', price: 45_500, advertised: 3600, recipe: [2180, 1060], active: false },
    { key: 'mega_10', name: 'Mega Oferta 110', price: 1_000, advertised: 110, recipe: [100], active: true, cap: 1 },
  ];

  for (const [index, spec] of specs.entries()) {
    const [combo] = await db
      .insert(combos)
      .values({
        campaignId: campaign!.id,
        key: spec.key,
        name: spec.name,
        priceMxnCents: spec.price,
        advertisedDiamonds: spec.advertised,
        active: spec.active,
        maxPerPlayer: spec.cap ?? null,
        sortOrder: index,
      })
      .returning();

    await db.insert(comboItems).values(
      spec.recipe.map((d, sequence) => ({
        comboId: combo!.id,
        baseProductId: byDenomination.get(d)!,
        sequence,
      })),
    );
  }
}

async function placeOrder(comboKey: string, playerId = '7288567050') {
  const result = await createOrder(
    { store: new DrizzleOrderingStore(db) },
    { comboKey, playerId, paymentMethod: 'transfer_manual', source: 'admin' },
  );
  if (!result.ok) throw new Error(`seed order failed: ${result.failure.code}`);
  return result.order;
}

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(
    raw`TRUNCATE orders, order_items, payments, combo_items, combos, campaigns, base_products, audit_log RESTART IDENTITY CASCADE`,
  );
  await seedCatalog();
});

describe.skipIf(!PG_AVAILABLE)('listPendingApprovals', () => {
  it('shows orders waiting on a comprobante, oldest first', async () => {
    const first = await placeOrder('pack_insano');
    await db
      .update(orders)
      .set({ createdAt: raw`now() - interval '2 hours'` })
      .where(eq(orders.id, first.id));
    const second = await placeOrder('mega_10');

    const queue = await listPendingApprovals(db);

    // The customer who has waited longest is the most annoyed.
    expect(queue.map((q) => q.orderNumber)).toEqual([first.orderNumber, second.orderNumber]);
    expect(queue[0]?.comboName).toBe('Pack Insano');
    expect(queue[0]?.priceMxnCents).toBe(86_000);
    expect(queue[0]?.advertisedDiamonds).toBe(7200);
  });

  it('drops an order once it is approved', async () => {
    const order = await placeOrder('pack_insano');
    expect(await listPendingApprovals(db)).toHaveLength(1);

    await approvePayment({ store: new DrizzlePaymentStore(db) }, { orderId: order.id });

    expect(await listPendingApprovals(db)).toHaveLength(0);
  });

  it('keeps a mismatched payment in the queue and flags it', async () => {
    const order = await placeOrder('pack_insano');
    await approvePayment(
      { store: new DrizzlePaymentStore(db) },
      { orderId: order.id, amountReceivedCents: 80_000 },
    );

    const queue = await listPendingApprovals(db);

    expect(queue).toHaveLength(1);
    expect(queue[0]?.mismatch).toBe(true);
    expect(queue[0]?.amountReceivedCents).toBe(80_000);
    expect(queue[0]?.paymentStatus).toBe('amount_mismatch');
  });

  it('is empty when there is nothing to approve', async () => {
    expect(await listPendingApprovals(db)).toEqual([]);
  });
});

describe.skipIf(!PG_AVAILABLE)('listOrders', () => {
  it('reports delivery progress per order', async () => {
    const order = await placeOrder('pack_insano');
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    await db.update(orderItems).set({ status: 'succeeded' }).where(eq(orderItems.id, items[0]!.id));

    const { rows } = await listOrders(db);

    expect(rows[0]?.itemsTotal).toBe(2);
    expect(rows[0]?.itemsDelivered).toBe(1);
  });

  it('filters to the orders a human has to look at', async () => {
    const stuck = await placeOrder('pack_insano');
    await placeOrder('mega_10');
    await db.update(orders).set({ status: 'needs_review' }).where(eq(orders.id, stuck.id));

    const { rows } = await listOrders(db, { filter: 'needs_attention' });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orderNumber).toBe(stuck.orderNumber);
  });

  it('finds an order by its number', async () => {
    const order = await placeOrder('pack_insano');
    const { rows } = await listOrders(db, { search: order.orderNumber.slice(-4) });
    expect(rows).toHaveLength(1);
  });

  it('finds an order by Free Fire ID — what a customer quotes on WhatsApp', async () => {
    await placeOrder('pack_insano', '7288567050');
    await placeOrder('mega_10', '1112223334');

    const { rows } = await listOrders(db, { search: '1112223334' });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.playerId).toBe('1112223334');
  });

  it('paginates with a stable total', async () => {
    await placeOrder('pack_insano', '1111111111');
    await placeOrder('pack_insano', '2222222222');
    await placeOrder('pack_insano', '3333333333');

    const page = await listOrders(db, { limit: 2, offset: 0 });

    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(3);
  });
});

describe.skipIf(!PG_AVAILABLE)('getOrderDetail', () => {
  it('returns the payment, the items and the progress', async () => {
    const order = await placeOrder('pack_insano');

    const detail = await getOrderDetail(db, order.id);

    expect(detail?.orderNumber).toBe(order.orderNumber);
    expect(detail?.payment?.method).toBe('transfer_manual');
    expect(detail?.payment?.amountExpectedCents).toBe(86_000);
    expect(detail?.items).toHaveLength(2);
    expect(detail?.progress).toEqual({ delivered: 0, total: 7326, pct: 0 });
  });

  it('surfaces how an ambiguous call was resolved', async () => {
    // This is the evidence a disputed recharge is settled with.
    const order = await placeOrder('pack_insano');
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));

    await db
      .update(orderItems)
      .set({
        status: 'succeeded',
        resolvedBy: 'wallet_delta',
        errorCode: 'timeout',
        walletBeforeUsd: '500.0000',
        walletAfterUsd: '472.5000',
        responsePayload: { outcome: { kind: 'ambiguous', reason: 'timeout' } },
      })
      .where(eq(orderItems.id, items[0]!.id));

    const detail = await getOrderDetail(db, order.id);
    const resolved = detail!.items.find((i) => i.resolvedBy === 'wallet_delta');

    expect(resolved?.status).toBe('succeeded');
    expect(resolved?.errorCode).toBe('timeout');
    expect(resolved?.walletBeforeUsd).toBe('500.0000');
    expect(resolved?.responsePayload).toBeTruthy();
  });

  it('computes partial progress in diamonds, not item count', async () => {
    // 5,600 delivered of 5,600 + 1,060 — 84% by diamonds, 50% by item count.
    const order = await placeOrder('pack_insano');
    const items = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(orderItems.sequence);
    await db.update(orderItems).set({ status: 'succeeded' }).where(eq(orderItems.id, items[0]!.id));

    const detail = await getOrderDetail(db, order.id);

    expect(detail?.progress.delivered).toBe(6160);
    expect(detail?.progress.total).toBe(7326);
    expect(detail?.progress.pct).toBeCloseTo(84.1, 1);
  });

  it('returns null for an unknown order', async () => {
    expect(await getOrderDetail(db, crypto.randomUUID())).toBeNull();
  });
});

describe.skipIf(!PG_AVAILABLE)('getDashboardStats', () => {
  it('counts what needs attention', async () => {
    await placeOrder('pack_insano', '1111111111');
    const stuck = await placeOrder('pack_insano', '2222222222');
    await db.update(orders).set({ status: 'needs_review' }).where(eq(orders.id, stuck.id));

    const stats = await getDashboardStats(db);

    expect(stats.awaitingApproval).toBe(1);
    expect(stats.needsReview).toBe(1);
  });

  it('reports revenue only for orders completed today', async () => {
    const order = await placeOrder('pack_insano');
    await db
      .update(orders)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(orders.id, order.id));

    const stats = await getDashboardStats(db);

    expect(stats.completedToday).toBe(1);
    expect(stats.revenueTodayCents).toBe(86_000);
  });

  it('excludes an order completed yesterday', async () => {
    const order = await placeOrder('pack_insano');
    await db
      .update(orders)
      .set({ status: 'completed', completedAt: raw`now() - interval '2 days'` })
      .where(eq(orders.id, order.id));

    const stats = await getDashboardStats(db);

    expect(stats.completedToday).toBe(0);
    expect(stats.revenueTodayCents).toBe(0);
  });

  it('surfaces combos blocked from sale', async () => {
    const stats = await getDashboardStats(db);
    expect(stats.inactiveCombos.map((c) => c.key)).toEqual(['pack_good']);
  });

  it('warns when a denomination has no active provider product', async () => {
    await db.update(baseProducts).set({ active: false }).where(eq(baseProducts.diamondsBase, 310));

    const stats = await getDashboardStats(db);

    expect(stats.missingProducts).toEqual([310]);
  });
});

describe.skipIf(!PG_AVAILABLE)('listCombosForAdmin', () => {
  it('does the recipe maths so the client can see the gap', async () => {
    const rows = await listCombosForAdmin(db);
    const good = rows.find((r) => r.key === 'pack_good');

    // The number the client needs every month when flyers rotate.
    expect(good?.advertisedDiamonds).toBe(3600);
    expect(good?.deliveredDiamonds).toBe(3564);
    expect(good?.gap).toBe(-36);
    expect(good?.active).toBe(false);
  });

  it('shows a healthy combo with a positive gap', async () => {
    const rows = await listCombosForAdmin(db);
    const insano = rows.find((r) => r.key === 'pack_insano');

    expect(insano?.deliveredDiamonds).toBe(7326);
    expect(insano?.gap).toBe(126);
    expect(insano?.callCount).toBe(2);
    expect(insano?.costUsd).toBe('33.3000');
  });

  it('carries the per-player cap through', async () => {
    const rows = await listCombosForAdmin(db);
    expect(rows.find((r) => r.key === 'mega_10')?.maxPerPlayer).toBe(1);
  });

  it('reports a combo with no recipe rather than hiding it', async () => {
    const [campaign] = await db.select().from(campaigns).limit(1);
    await db.insert(combos).values({
      campaignId: campaign!.id,
      key: 'orphan',
      name: 'Sin receta',
      priceMxnCents: 10_000,
      advertisedDiamonds: 1000,
    });

    const orphan = (await listCombosForAdmin(db)).find((r) => r.key === 'orphan');

    expect(orphan?.callCount).toBe(0);
    expect(orphan?.deliveredDiamonds).toBe(0);
    expect(orphan?.costUsd).toBeNull();
  });
});
