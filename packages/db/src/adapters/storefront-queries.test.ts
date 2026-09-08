/**
 * Storefront read models against real Postgres.
 *
 * The assertions that matter most are the negative ones: what the public API
 * must NOT return, and who must NOT be able to read an order.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createOrder } from '@levelup/engine';
import { createDb, type Database } from '../index.js';
import { baseProducts, campaigns, comboItems, combos, orderItems, orders } from '../schema.js';
import { DrizzleOrderingStore } from './ordering-store.js';
import {
  countCompletedOrders,
  findCustomerOrder,
  getStorefrontCombo,
  listStorefront,
} from './storefront-queries.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_storefront_test';

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

const productIds = new Map<number, string>();

interface ComboSpec {
  key: string;
  name: string;
  price: number;
  advertised: number;
  recipe: number[];
  active?: boolean;
  cap?: number;
  sort?: number;
}

async function seedCampaign(spec: {
  key: string;
  name: string;
  permanent?: boolean;
  active?: boolean;
  sort?: number;
  endsAt?: Date;
  flyer?: string;
  combos: ComboSpec[];
}) {
  const [campaign] = await db
    .insert(campaigns)
    .values({
      key: spec.key,
      name: spec.name,
      permanent: spec.permanent ?? false,
      active: spec.active ?? true,
      sortOrder: spec.sort ?? 0,
      flyerAssetUrl: spec.flyer ?? null,
      endsAt: spec.endsAt ?? null,
    })
    .returning();

  for (const [i, c] of spec.combos.entries()) {
    const [combo] = await db
      .insert(combos)
      .values({
        campaignId: campaign!.id,
        key: c.key,
        name: c.name,
        priceMxnCents: c.price,
        advertisedDiamonds: c.advertised,
        active: c.active ?? true,
        maxPerPlayer: c.cap ?? null,
        sortOrder: c.sort ?? i,
      })
      .returning();

    await db.insert(comboItems).values(
      c.recipe.map((d, sequence) => ({
        comboId: combo!.id,
        baseProductId: productIds.get(d)!,
        sequence,
      })),
    );
  }
}

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(
    raw`TRUNCATE orders, order_items, payments, combo_items, combos, campaigns, base_products RESTART IDENTITY CASCADE`,
  );

  productIds.clear();
  for (const [d, cost] of [
    [100, '0.7000'],
    [1060, '6.5900'],
    [5600, '33.2700'],
  ] as const) {
    const [p] = await db
      .insert(baseProducts)
      .values({
        providerProductId: `p${d}`,
        endpointKind: 'pins_recharge',
        name: `Free Fire ${d}`,
        diamondsBase: d,
        costUsd: cost,
        canValidate: true,
      })
      .returning();
    productIds.set(d, p!.id);
  }
});

describe.skipIf(!PG_AVAILABLE)('listStorefront', () => {
  beforeEach(async () => {
    await seedCampaign({
      key: 'super_packs',
      name: 'SUPER PACKS',
      sort: 1,
      combos: [
        { key: 'pack_insano', name: 'Pack Insano', price: 86_000, advertised: 7200, recipe: [5600, 1060] },
      ],
    });
    await seedCampaign({
      key: 'mega_oferta',
      name: 'MEGA OFERTA',
      permanent: true,
      sort: 9,
      combos: [
        { key: 'mega_10', name: 'Mega Oferta 110', price: 1_000, advertised: 110, recipe: [100], cap: 1 },
      ],
    });
  });

  it('never exposes the recipe or the provider cost', async () => {
    // This is the differentiator: competitors sell the six base denominations,
    // LevelUp sells bundles of them. Leaking the recipe gives that away.
    const campaigns = await listStorefront(db);
    const combo = campaigns.flatMap((c) => c.combos).find((c) => c.key === 'pack_insano');

    expect(combo).toBeDefined();
    expect(Object.keys(combo!).sort()).toEqual([
      'advertisedDiamonds',
      'key',
      'maxPerPlayer',
      'name',
      'priceMxnCents',
    ]);
    expect(JSON.stringify(campaigns)).not.toContain('5600');
    expect(JSON.stringify(campaigns)).not.toContain('33.27');
  });

  it('leads with the permanent $10 offer despite its sort order', async () => {
    // It is the entry offer for distrustful first-time buyers.
    const result = await listStorefront(db);
    expect(result[0]?.key).toBe('mega_oferta');
    expect(result[0]?.combos[0]?.maxPerPlayer).toBe(1);
  });

  it('hides a combo that is switched off', async () => {
    await db.update(combos).set({ active: false }).where(eq(combos.key, 'pack_insano'));
    const keys = (await listStorefront(db)).flatMap((c) => c.combos.map((x) => x.key));
    expect(keys).not.toContain('pack_insano');
  });

  it('hides everything under a switched-off campaign', async () => {
    await db.update(campaigns).set({ active: false }).where(eq(campaigns.key, 'super_packs'));
    expect((await listStorefront(db)).map((c) => c.key)).toEqual(['mega_oferta']);
  });

  it('hides a campaign whose window has closed', async () => {
    // How the monthly flyer rotation actually retires a promo.
    await db
      .update(campaigns)
      .set({ endsAt: new Date(Date.now() - 86_400_000) })
      .where(eq(campaigns.key, 'super_packs'));

    expect((await listStorefront(db)).map((c) => c.key)).toEqual(['mega_oferta']);
  });

  it('hides a combo scheduled to start later', async () => {
    await db
      .update(combos)
      .set({ startsAt: new Date(Date.now() + 86_400_000) })
      .where(eq(combos.key, 'pack_insano'));

    const keys = (await listStorefront(db)).flatMap((c) => c.combos.map((x) => x.key));
    expect(keys).not.toContain('pack_insano');
  });
});

describe.skipIf(!PG_AVAILABLE)('getStorefrontCombo', () => {
  beforeEach(async () => {
    await seedCampaign({
      key: 'super_packs',
      name: 'SUPER PACKS',
      flyer: 'https://cdn/superpacks.jpg',
      combos: [
        { key: 'pack_insano', name: 'Pack Insano', price: 86_000, advertised: 7200, recipe: [5600, 1060] },
      ],
    });
  });

  it('returns the combo with its flyer', async () => {
    const combo = await getStorefrontCombo(db, 'pack_insano');
    expect(combo?.name).toBe('Pack Insano');
    expect(combo?.flyerAssetUrl).toBe('https://cdn/superpacks.jpg');
    expect(combo?.advertisedDiamonds).toBe(7200);
  });

  it('returns null for a combo that is not on sale', async () => {
    await db.update(combos).set({ active: false }).where(eq(combos.key, 'pack_insano'));
    expect(await getStorefrontCombo(db, 'pack_insano')).toBeNull();
  });

  it('returns null for a combo that does not exist', async () => {
    expect(await getStorefrontCombo(db, 'no_existe')).toBeNull();
  });
});

describe.skipIf(!PG_AVAILABLE)('findCustomerOrder', () => {
  async function placeOrder(playerId = '7288567050') {
    await seedCampaign({
      key: 'super_packs',
      name: 'SUPER PACKS',
      combos: [
        { key: 'pack_insano', name: 'Pack Insano', price: 86_000, advertised: 7200, recipe: [5600, 1060] },
      ],
    }).catch(() => undefined);

    const result = await createOrder(
      { store: new DrizzleOrderingStore(db) },
      { comboKey: 'pack_insano', playerId, paymentMethod: 'transfer_manual', source: 'storefront' },
    );
    if (!result.ok) throw new Error(result.failure.code);
    return result.order;
  }

  it('finds an order with the right number and player ID', async () => {
    const order = await placeOrder();
    const found = await findCustomerOrder(db, order.orderNumber, '7288567050');

    expect(found?.orderNumber).toBe(order.orderNumber);
    expect(found?.comboName).toBe('Pack Insano');
    expect(found?.status).toBe('esperando_pago');
  });

  it('refuses the right number with the wrong player ID', async () => {
    // There are no accounts — this pairing IS the authorisation model.
    const order = await placeOrder();
    expect(await findCustomerOrder(db, order.orderNumber, '9999999999')).toBeNull();
  });

  it('refuses a guessed order number', async () => {
    await placeOrder();
    expect(await findCustomerOrder(db, 'LU-260101-AAAA', '7288567050')).toBeNull();
  });

  it('tolerates casing and whitespace a customer would paste', async () => {
    const order = await placeOrder();
    const found = await findCustomerOrder(db, `  ${order.orderNumber.toLowerCase()} `, ' 7288567050 ');
    expect(found?.orderNumber).toBe(order.orderNumber);
  });

  it('never exposes the individual provider calls', async () => {
    // The customer bought one thing and sees one thing.
    const order = await placeOrder();
    const found = await findCustomerOrder(db, order.orderNumber, '7288567050');

    expect(Object.keys(found!)).not.toContain('items');
    expect(JSON.stringify(found)).not.toContain('5600');
  });

  it('reports progress in diamonds as items are delivered', async () => {
    const order = await placeOrder();
    const items = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(orderItems.sequence);

    await db.update(orderItems).set({ status: 'succeeded' }).where(eq(orderItems.id, items[0]!.id));
    await db.update(orders).set({ status: 'processing' }).where(eq(orders.id, order.id));

    const found = await findCustomerOrder(db, order.orderNumber, '7288567050');
    expect(found?.status).toBe('procesando');
    expect(found?.deliveredDiamonds).toBe(6160);
  });

  it.each([
    ['payment_confirmed', 'procesando'],
    ['partially_delivered', 'procesando'],
    ['completed', 'completado'],
    ['cancelled', 'cancelado'],
    ['payment_expired', 'cancelado'],
  ])('shows %s as %s', async (internal, expected) => {
    const order = await placeOrder();
    await db.update(orders).set({ status: internal as never }).where(eq(orders.id, order.id));

    const found = await findCustomerOrder(db, order.orderNumber, '7288567050');
    expect(found?.status).toBe(expected);
    expect(found?.needsSupport).toBe(false);
  });

  it('offers support only when an order actually needs a human', async () => {
    // The client does not want a floating WhatsApp button — this is the one
    // place it appears, and only for orders an admin is already handling.
    const order = await placeOrder();
    await db.update(orders).set({ status: 'needs_review' }).where(eq(orders.id, order.id));

    const found = await findCustomerOrder(db, order.orderNumber, '7288567050');
    expect(found?.status).toBe('con_problema');
    expect(found?.needsSupport).toBe(true);
  });
});

describe.skipIf(!PG_AVAILABLE)('countCompletedOrders', () => {
  it('counts only completed orders, for the trust page', async () => {
    await seedCampaign({
      key: 'super_packs',
      name: 'SUPER PACKS',
      combos: [
        { key: 'pack_insano', name: 'Pack Insano', price: 86_000, advertised: 7200, recipe: [5600, 1060] },
      ],
    });

    for (const playerId of ['1111111111', '2222222222', '3333333333']) {
      await createOrder(
        { store: new DrizzleOrderingStore(db) },
        { comboKey: 'pack_insano', playerId, paymentMethod: 'transfer_manual', source: 'storefront' },
      );
    }
    await db.update(orders).set({ status: 'completed' }).where(eq(orders.playerId, '1111111111'));

    expect(await countCompletedOrders(db)).toBe(1);
  });
});
