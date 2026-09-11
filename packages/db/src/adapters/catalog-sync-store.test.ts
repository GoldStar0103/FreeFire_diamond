/**
 * Catalog sync against real Postgres, end to end: an empty database, a provider
 * catalog, and afterwards a combo that can actually be ordered.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { asc, eq, inArray, sql as raw } from 'drizzle-orm';
import { ProviderSimulator, type ProviderProduct, type UsdTenK } from '@levelup/provider';
import { createOrder, syncCatalog, type OrderItemStatus, type OrderStatus } from '@levelup/engine';
import { createDb, type Database } from '../index.js';
import {
  auditLog,
  baseProducts,
  campaigns,
  comboItems,
  combos,
  orderItems,
  orders,
} from '../schema.js';
import { DrizzleCatalogSyncStore } from './catalog-sync-store.js';
import { DrizzleOrderingStore } from './ordering-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_catalog_test';

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
    raw`TRUNCATE orders, order_items, payments, combo_items, combos, campaigns, base_products, audit_log RESTART IDENTITY CASCADE`,
  );
});

const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;

const catalogOf = (denominations: number[], costFor: (d: number) => number): ProviderProduct[] =>
  denominations.map((d) => ({
    providerProductId: `d${d}`,
    endpointKind: 'pins_recharge' as const,
    name: `Free Fire ${d} Diamonds`,
    sku: `FF${d}`,
    diamondsBase: d,
    costUsd: usd(costFor(d)),
    requiresServerId: false,
    canValidate: true,
    raw: {},
  }));

function syncWith(catalog: ProviderProduct[]) {
  const provider = new ProviderSimulator();
  provider.programCatalog(catalog);
  return syncCatalog({ store: new DrizzleCatalogSyncStore(db), provider });
}

const ALL_SIX = [100, 310, 520, 1060, 2180, 5600];

describe.skipIf(!PG_AVAILABLE)('first sync', () => {
  it('populates base_products from an empty database', async () => {
    const result = await syncWith(catalogOf(ALL_SIX, (d) => d / 200));

    expect(result.mapped).toEqual(ALL_SIX);
    expect(result.added).toHaveLength(6);
    expect(result.blocked).toBe(false);

    const rows = await db.select().from(baseProducts);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.active)).toBe(true);
    expect(rows.every((r) => r.lastSyncedAt !== null)).toBe(true);

    const [big] = await db
      .select()
      .from(baseProducts)
      .where(eq(baseProducts.diamondsBase, 5600));
    expect(big?.costUsd).toBe('28.0000');
    expect(big?.canValidate).toBe(true);
  });

  it('is idempotent', async () => {
    await syncWith(catalogOf(ALL_SIX, (d) => d / 200));
    const second = await syncWith(catalogOf(ALL_SIX, (d) => d / 200));

    expect(second.added).toHaveLength(0);
    expect(second.updated).toHaveLength(6);
    expect(second.costChanges).toHaveLength(0);
    expect(await db.select().from(baseProducts)).toHaveLength(6);
  });
});

describe.skipIf(!PG_AVAILABLE)('cost drift', () => {
  it('detects and persists a price rise', async () => {
    await syncWith(catalogOf([5600], () => 27.5));
    const result = await syncWith(catalogOf([5600], () => 30));

    expect(result.costChanges).toHaveLength(1);
    expect(result.costChanges[0]?.pctChange).toBeCloseTo(9.09, 1);

    const [row] = await db.select().from(baseProducts);
    expect(row?.costUsd).toBe('30.0000');
  });
});

describe.skipIf(!PG_AVAILABLE)('withdrawn products', () => {
  it('deactivates without deleting, preserving recipe references', async () => {
    await syncWith(catalogOf(ALL_SIX, (d) => d / 200));

    // The provider stops offering 310.
    const result = await syncWith(catalogOf(ALL_SIX.filter((d) => d !== 310), (d) => d / 200));

    expect(result.deactivated).toEqual(['d310']);
    expect(result.missing).toEqual([310]);

    const rows = await db.select().from(baseProducts);
    // Still six rows — the withdrawn one is inactive, not gone.
    expect(rows).toHaveLength(6);
    const [withdrawn] = rows.filter((r) => r.providerProductId === 'd310');
    expect(withdrawn?.active).toBe(false);
  });

  it('reactivates a product the provider starts offering again', async () => {
    await syncWith(catalogOf(ALL_SIX, (d) => d / 200));
    await syncWith(catalogOf(ALL_SIX.filter((d) => d !== 310), (d) => d / 200));
    await syncWith(catalogOf(ALL_SIX, (d) => d / 200));

    const [restored] = await db
      .select()
      .from(baseProducts)
      .where(eq(baseProducts.providerProductId, 'd310'));
    expect(restored?.active).toBe(true);
  });
});

describe.skipIf(!PG_AVAILABLE)('unusable catalog', () => {
  it('stores nothing when everything is a redeemable code', async () => {
    const codes = catalogOf(ALL_SIX, (d) => d / 200).map((p) => ({
      ...p,
      endpointKind: 'pins_code' as const,
      canValidate: false,
    }));

    const result = await syncWith(codes);

    // The whole "recarga directa al ID" premise fails on this catalog.
    expect(result.blocked).toBe(true);
    expect(result.skipped).toHaveLength(6);
    expect(await db.select().from(baseProducts)).toHaveLength(0);
  });
});

describe.skipIf(!PG_AVAILABLE)('the point of all this', () => {
  it('turns an unorderable combo into an orderable one', async () => {
    // Seed a combo whose recipe has no products yet — the state the real
    // database is in right now, with 59 recipe items unlinked.
    const [campaign] = await db
      .insert(campaigns)
      .values({ key: 'chidos', name: 'DESCUENTOS CHIDOS' })
      .returning();
    const [combo] = await db
      .insert(combos)
      .values({
        campaignId: campaign!.id,
        key: 'chidos_3000',
        name: 'Descuentos Chidos 3000',
        priceMxnCents: 40_000,
        advertisedDiamonds: 3000,
      })
      .returning();

    const before = await createOrder(
      { store: new DrizzleOrderingStore(db) },
      {
        comboKey: 'chidos_3000',
        playerId: '7288567050',
        paymentMethod: 'transfer_manual',
        source: 'storefront',
      },
    );
    expect(before).toMatchObject({ failure: { code: 'RECIPE_EMPTY' } });

    // Sync the provider catalog, then wire the recipe (what re-running the
    // seed does): 2,180 + 520 + 100 delivers 3,080 against 3,000 advertised.
    await syncWith(catalogOf(ALL_SIX, (d) => d / 200));
    const products = await db.select().from(baseProducts);
    const byDenomination = new Map(products.map((p) => [p.diamondsBase, p.id]));

    await db.insert(comboItems).values(
      [2180, 520, 100].map((d, index) => ({
        comboId: combo!.id,
        baseProductId: byDenomination.get(d)!,
        sequence: index,
      })),
    );

    const after = await createOrder(
      { store: new DrizzleOrderingStore(db) },
      {
        comboKey: 'chidos_3000',
        playerId: '7288567050',
        paymentMethod: 'transfer_manual',
        source: 'storefront',
      },
    );

    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error('unreachable');
    expect(after.order.items).toHaveLength(3);
    expect(after.order.comboSnapshot.deliveredDiamonds).toBe(3080);
  });

  it('reports combos still missing a recipe', async () => {
    const [campaign] = await db
      .insert(campaigns)
      .values({ key: 'chidos', name: 'DESCUENTOS CHIDOS' })
      .returning();
    await db.insert(combos).values({
      campaignId: campaign!.id,
      key: 'chidos_1700',
      name: 'Descuentos Chidos 1700',
      priceMxnCents: 26_000,
      advertisedDiamonds: 1700,
    });

    const incomplete = await new DrizzleCatalogSyncStore(db).findIncompleteRecipes();
    expect(incomplete).toEqual([
      { comboKey: 'chidos_1700', name: 'Descuentos Chidos 1700', items: 0 },
    ]);
  });
});

// ── the 2026-09-15 catalog change ───────────────────────────────────────────

/** The live ids and prices today — phase0/out/REPORT.md. */
const LIVE: Record<number, { id: string; usd: number }> = {
  100: { id: '351', usd: 0.7 },
  310: { id: '348', usd: 2.1 },
  520: { id: '350', usd: 3.55 },
  1060: { id: '347', usd: 6.59 },
  2180: { id: '346', usd: 13.07 },
  5600: { id: '349', usd: 33.27 },
};

function catalogWith(overrides: Record<number, { id: string; usd: number }> = {}): ProviderProduct[] {
  return Object.entries({ ...LIVE, ...overrides }).map(([d, p]) => ({
    providerProductId: p.id,
    endpointKind: 'pins_recharge' as const,
    name: `Free Fire ${d} Diamantes`,
    sku: null,
    diamondsBase: Number(d),
    costUsd: usd(p.usd),
    requiresServerId: false,
    canValidate: true,
    raw: {},
  }));
}

const productRowId = async (providerProductId: string): Promise<string> => {
  const [row] = await db
    .select({ id: baseProducts.id })
    .from(baseProducts)
    .where(eq(baseProducts.providerProductId, providerProductId));
  if (!row) throw new Error(`No base product ${providerProductId}`);
  return row.id;
};

/** Two combos, three recipe slots on 100 diamonds between them. */
async function seedCombos(): Promise<void> {
  const [campaign] = await db
    .insert(campaigns)
    .values({ key: 'chidos', name: 'DESCUENTOS CHIDOS' })
    .returning();

  const recipes: Record<string, number[]> = {
    chidos_3000: [2180, 520, 100],
    chidos_200: [100, 100],
  };

  for (const [key, recipe] of Object.entries(recipes)) {
    const [combo] = await db
      .insert(combos)
      .values({
        campaignId: campaign!.id,
        key,
        name: key,
        priceMxnCents: 10_000,
        advertisedDiamonds: recipe.reduce((a, b) => a + b, 0),
      })
      .returning();

    await db.insert(comboItems).values(
      await Promise.all(
        recipe.map(async (d, sequence) => ({
          comboId: combo!.id,
          baseProductId: await productRowId(LIVE[d]!.id),
          sequence,
        })),
      ),
    );
  }
}

let orderSeq = 0;

/** An order carrying a 100-diamond item on the old id in the given state. */
async function orderWith(
  orderStatus: OrderStatus,
  itemStatus: OrderItemStatus,
  providerProductId = LIVE[100]!.id,
): Promise<{ orderId: string; itemId: string; snapshot: unknown }> {
  const snapshot = {
    name: 'chidos_200',
    recipe: [{ providerProductId, diamondsBase: 100, costUsd: 0.7 }],
  };
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `LU-T${String(++orderSeq).padStart(5, '0')}`,
      playerId: '7288567050',
      comboKey: 'chidos_200',
      comboSnapshot: snapshot,
      priceMxnCents: 10_000,
      status: orderStatus,
    })
    .returning({ id: orders.id });

  const [item] = await db
    .insert(orderItems)
    .values({
      orderId: order!.id,
      sequence: 0,
      baseProductId: await productRowId(providerProductId),
      providerProductId,
      diamondsBase: 100,
      costUsd: '0.7000',
      status: itemStatus,
    })
    .returning({ id: orderItems.id });

  return { orderId: order!.id, itemId: item!.id, snapshot };
}

const itemRow = async (itemId: string) => {
  const [row] = await db.select().from(orderItems).where(eq(orderItems.id, itemId));
  return row!;
};

describe.skipIf(!PG_AVAILABLE)('a provider product replaced by a new id', () => {
  beforeEach(async () => {
    await syncWith(catalogWith());
    await seedCombos();
  });

  it('moves recipes onto the new product, so combos stay orderable', async () => {
    const result = await syncWith(catalogWith({ 100: { id: '901', usd: 0.72 } }));

    expect(result.replaced).toEqual([
      {
        denomination: 100,
        fromProviderProductId: '351',
        toProviderProductId: '901',
        previousCostUsd: usd(0.7),
        currentCostUsd: usd(0.72),
      },
    ]);
    expect(result.repointed).toEqual([
      expect.objectContaining({ fromProviderProductId: '351', recipeItems: 3, orderItems: 0 }),
    ]);

    const newRowId = await productRowId('901');
    const oldRowId = await productRowId('351');
    const slots = await db.select().from(comboItems);
    expect(slots.filter((s) => s.baseProductId === newRowId)).toHaveLength(3);
    expect(slots.filter((s) => s.baseProductId === oldRowId)).toHaveLength(0);

    // The old row is kept — historical items reference it — but off sale.
    const [old] = await db.select().from(baseProducts).where(eq(baseProducts.id, oldRowId));
    expect(old?.active).toBe(false);

    // The actual point: without the re-point this fails PRODUCT_UNAVAILABLE.
    const order = await createOrder(
      { store: new DrizzleOrderingStore(db) },
      {
        comboKey: 'chidos_3000',
        playerId: '7288567050',
        paymentMethod: 'transfer_manual',
        source: 'storefront',
      },
    );
    expect(order.ok).toBe(true);
    if (!order.ok) throw new Error('unreachable');
    expect(order.order.items.map((i) => i.providerProductId)).toEqual(['346', '350', '901']);
  });

  it('survives all six ids changing at once', async () => {
    const renumbered = Object.fromEntries(
      Object.entries(LIVE).map(([d, p]) => [d, { id: `9${p.id}`, usd: p.usd }]),
    );
    const result = await syncWith(catalogWith(renumbered));

    expect(result.replaced).toHaveLength(6);
    expect(result.deactivated.sort()).toEqual(Object.values(LIVE).map((p) => p.id).sort());

    const order = await createOrder(
      { store: new DrizzleOrderingStore(db) },
      {
        comboKey: 'chidos_3000',
        playerId: '7288567050',
        paymentMethod: 'transfer_manual',
        source: 'storefront',
      },
    );
    expect(order.ok).toBe(true);
  });

  it('moves queued and failed items of live orders, at the new cost', async () => {
    // The new cost matters: wallet-delta reconciliation compares the observed
    // debit against it. The old cost would make every ambiguity indeterminate.
    const live = await Promise.all([
      orderWith('pending_payment', 'queued'),
      orderWith('payment_confirmed', 'queued'),
      orderWith('partially_delivered', 'failed'),
      orderWith('needs_review', 'failed'),
    ]);

    const result = await syncWith(catalogWith({ 100: { id: '901', usd: 0.72 } }));

    expect(result.repointed[0]?.orderItems).toBe(4);
    const newRowId = await productRowId('901');
    for (const { itemId } of live) {
      const row = await itemRow(itemId);
      expect(row.providerProductId).toBe('901');
      expect(row.baseProductId).toBe(newRowId);
      expect(row.costUsd).toBe('0.7200');
    }
  });

  it('never touches an item that may have reached the provider', async () => {
    // Each of these is reconciled — or already settled — against the OLD id
    // and cost. Rewriting them would destroy the evidence.
    const touched = await Promise.all(
      (['sending', 'unknown', 'succeeded', 'provider_pending'] as const).map((s) =>
        orderWith('processing', s),
      ),
    );

    await syncWith(catalogWith({ 100: { id: '901', usd: 0.72 } }));

    const oldRowId = await productRowId('351');
    for (const { itemId } of touched) {
      const row = await itemRow(itemId);
      expect(row.providerProductId).toBe('351');
      expect(row.baseProductId).toBe(oldRowId);
      expect(row.costUsd).toBe('0.7000');
    }
  });

  it('never touches items of a closed order', async () => {
    const closed = await Promise.all(
      (['completed', 'cancelled', 'payment_expired', 'refund_required'] as const).flatMap((s) => [
        orderWith(s, 'queued'),
        orderWith(s, 'failed'),
      ]),
    );

    const result = await syncWith(catalogWith({ 100: { id: '901', usd: 0.72 } }));

    expect(result.repointed[0]?.orderItems).toBe(0);
    for (const { itemId } of closed) {
      expect((await itemRow(itemId)).providerProductId).toBe('351');
    }
  });

  it('leaves other denominations and the combo snapshot alone', async () => {
    const other = await orderWith('payment_confirmed', 'queued', LIVE[310]!.id);
    const moved = await orderWith('payment_confirmed', 'queued');

    await syncWith(catalogWith({ 100: { id: '901', usd: 0.72 } }));

    expect((await itemRow(other.itemId)).providerProductId).toBe('348');

    // The snapshot is the frozen record of what was bought. Fulfilment reads
    // items, so the snapshot keeps saying 351 even though the item now says 901.
    const [order] = await db.select().from(orders).where(eq(orders.id, moved.orderId));
    expect(order?.comboSnapshot).toEqual(moved.snapshot);
  });

  it('writes an audit row for every recipe slot and item it moves', async () => {
    const { itemId } = await orderWith('payment_confirmed', 'queued');

    await syncWith(catalogWith({ 100: { id: '901', usd: 0.72 } }));

    const entries = await db.select().from(auditLog).orderBy(asc(auditLog.action));
    const recipes = entries.filter((e) => e.action === 'catalog.recipe_repointed');
    const items = entries.filter((e) => e.action === 'catalog.order_item_repointed');

    expect(recipes).toHaveLength(3);
    expect(recipes.every((e) => e.adminUserId === null && e.entityType === 'combo_item')).toBe(true);
    expect(recipes.map((e) => (e.detail as { comboKey: string }).comboKey).sort()).toEqual([
      'chidos_200',
      'chidos_200',
      'chidos_3000',
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      adminUserId: null,
      entityType: 'order_item',
      entityId: itemId,
      detail: {
        denomination: 100,
        fromProviderProductId: '351',
        toProviderProductId: '901',
        orderNumber: expect.stringMatching(/^LU-T/),
        itemStatus: 'queued',
        previousCostUsd: '0.7000',
        currentCostUsd: '0.7200',
      },
    });
  });

  it('rolls the whole re-point back if any part of it fails', async () => {
    // A recipe moved without its unsent items would leave a paid order and its
    // combo disagreeing about which SKU fulfils it.
    const { itemId } = await orderWith('payment_confirmed', 'queued');
    const store = new DrizzleCatalogSyncStore(db);
    await store.upsertProducts([
      {
        providerProductId: '901',
        endpointKind: 'pins_recharge',
        sku: null,
        name: 'Free Fire 100 Diamantes',
        diamondsBase: 100,
        costUsd: usd(0.72),
        requiresServerId: false,
        canValidate: true,
      },
    ]);

    // The first entry is valid and would move rows; the second targets a
    // product that was never stored.
    await expect(
      store.repointProducts([
        { denomination: 100, fromProviderProductId: '351', toProviderProductId: '901', costUsd: usd(0.72) },
        { denomination: 310, fromProviderProductId: '348', toProviderProductId: 'nope', costUsd: usd(2) },
      ]),
    ).rejects.toThrow(/nope/);

    expect((await itemRow(itemId)).providerProductId).toBe('351');
    const oldRowId = await productRowId('351');
    const slots = await db.select().from(comboItems);
    expect(slots.filter((s) => s.baseProductId === oldRowId)).toHaveLength(3);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it('is a no-op the second time', async () => {
    await orderWith('payment_confirmed', 'queued');
    await syncWith(catalogWith({ 100: { id: '901', usd: 0.72 } }));
    const auditBefore = (await db.select().from(auditLog)).length;

    const again = await syncWith(catalogWith({ 100: { id: '901', usd: 0.72 } }));

    expect(again.replaced).toEqual([]);
    expect(again.repointed).toEqual([]);
    expect(await db.select().from(auditLog)).toHaveLength(auditBefore);
  });

  it('sweeps up an order that still carried the old id after the replacement', async () => {
    // An order whose recipe was read in the instant before the re-point
    // committed. The next sync moves it, and says so.
    await syncWith(catalogWith({ 100: { id: '901', usd: 0.72 } }));
    const straggler = await orderWith('payment_confirmed', 'queued');

    const next = await syncWith(catalogWith({ 100: { id: '901', usd: 0.72 } }));

    expect(next.replaced).toEqual([]);
    expect(next.repointed).toEqual([
      expect.objectContaining({ fromProviderProductId: '351', orderItems: 1 }),
    ]);
    expect((await itemRow(straggler.itemId)).providerProductId).toBe('901');
  });
});

describe.skipIf(!PG_AVAILABLE)('a broken catalog response', () => {
  beforeEach(async () => {
    await syncWith(catalogWith());
    await seedCombos();
  });

  it('deactivates nothing when the provider returns an empty catalog', async () => {
    const result = await syncWith([]);

    expect(result.deactivationSkipped?.reason).toBe('empty_catalog');
    const rows = await db.select().from(baseProducts);
    expect(rows.every((r) => r.active)).toBe(true);

    const order = await createOrder(
      { store: new DrizzleOrderingStore(db) },
      {
        comboKey: 'chidos_3000',
        playerId: '7288567050',
        paymentMethod: 'transfer_manual',
        source: 'storefront',
      },
    );
    expect(order.ok).toBe(true);
  });

  it('deactivates nothing when no name can be parsed', async () => {
    const garbled = catalogWith().map((p) => ({ ...p, name: 'FF Paquete', diamondsBase: null }));

    const result = await syncWith(garbled);

    expect(result.deactivationSkipped?.reason).toBe('nothing_mapped');
    const active = await db
      .select()
      .from(baseProducts)
      .where(inArray(baseProducts.providerProductId, Object.values(LIVE).map((p) => p.id)));
    expect(active.every((r) => r.active)).toBe(true);
  });
});
