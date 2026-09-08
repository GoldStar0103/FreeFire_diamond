/**
 * Order creation against real Postgres — the full path from a combo key to an
 * order the fulfilment worker can pick up.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { asc, eq, sql as raw } from 'drizzle-orm';
import { createOrder } from '@levelup/engine';
import { createDb, type Database } from '../index.js';
import { baseProducts, campaigns, comboItems, combos, orderItems, orders, payments } from '../schema.js';
import { DrizzleOrderingStore } from './ordering-store.js';
import { DrizzleOrderQueue } from './order-queue.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_ordering_test';

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
    raw`TRUNCATE orders, order_items, payments, combo_items, combos, campaigns, base_products RESTART IDENTITY CASCADE`,
  );
});

/** Seed a campaign, its base SKUs and one combo with the given recipe. */
async function seedCombo(options: {
  comboKey: string;
  advertised: number;
  priceMxn: number;
  recipe: number[];
  maxPerPlayer?: number | null;
  active?: boolean;
  campaignActive?: boolean;
  costUsd?: string | null;
}) {
  const [campaign] = await db
    .insert(campaigns)
    .values({
      key: 'sept',
      name: 'PACKS MEGA PRIME',
      active: options.campaignActive ?? true,
    })
    .returning();

  const products = new Map<number, string>();
  for (const denomination of new Set(options.recipe)) {
    const [product] = await db
      .insert(baseProducts)
      .values({
        providerProductId: `d${denomination}`,
        endpointKind: 'pins_recharge',
        name: `Free Fire ${denomination}`,
        diamondsBase: denomination,
        costUsd: options.costUsd === undefined ? (denomination / 200).toFixed(4) : options.costUsd,
      })
      .returning();
    products.set(denomination, product!.id);
  }

  const [combo] = await db
    .insert(combos)
    .values({
      campaignId: campaign!.id,
      key: options.comboKey,
      name: options.comboKey,
      priceMxnCents: options.priceMxn * 100,
      advertisedDiamonds: options.advertised,
      maxPerPlayer: options.maxPerPlayer ?? null,
      active: options.active ?? true,
    })
    .returning();

  await db.insert(comboItems).values(
    options.recipe.map((denomination, index) => ({
      comboId: combo!.id,
      baseProductId: products.get(denomination)!,
      sequence: index,
    })),
  );

  return combo!;
}

const store = () => new DrizzleOrderingStore(db);

const input = (overrides = {}) => ({
  comboKey: 'mega_prime_48k',
  playerId: '7288567050',
  paymentMethod: 'transfer_manual' as const,
  source: 'storefront' as const,
  ...overrides,
});

describe.skipIf(!PG_AVAILABLE)('createOrder end to end', () => {
  it('expands an 8-call combo into rows the worker can pick up', async () => {
    await seedCombo({
      comboKey: 'mega_prime_48k',
      advertised: 48_800,
      priceMxn: 5850,
      recipe: Array(8).fill(5600),
    });

    const result = await createOrder({ store: store() }, input());
    expect(result.ok).toBe(true);

    const [order] = await db.select().from(orders);
    expect(order?.status).toBe('pending_payment');
    expect(order?.priceMxnCents).toBe(585_000);

    const items = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order!.id))
      .orderBy(asc(orderItems.sequence));

    expect(items).toHaveLength(8);
    expect(items.map((i) => i.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(items.every((i) => i.status === 'queued')).toBe(true);
    // Cost is frozen per item so a later catalog re-sync cannot change what an
    // in-flight order expects to be charged.
    expect(items.every((i) => i.costUsd === '28.0000')).toBe(true);
  });

  it('creates the payment row in the same transaction', async () => {
    await seedCombo({ comboKey: 'mega_prime_48k', advertised: 6160, priceMxn: 750, recipe: [5600] });

    await createOrder({ store: store() }, input());

    const [payment] = await db.select().from(payments);
    expect(payment?.method).toBe('transfer_manual');
    expect(payment?.status).toBe('pending');
    expect(payment?.amountExpectedCents).toBe(75_000);
  });

  it('writes nothing at all when the recipe under-delivers', async () => {
    // Pack Good: 2,180 + 1,060 delivers 3,564 against 3,600 advertised.
    await seedCombo({
      comboKey: 'mega_prime_48k',
      advertised: 3600,
      priceMxn: 455,
      recipe: [2180, 1060],
    });

    const result = await createOrder({ store: store() }, input());

    expect(result).toMatchObject({ failure: { code: 'RECIPE_UNDER_DELIVERS' } });
    expect(await db.select().from(orders)).toHaveLength(0);
    expect(await db.select().from(payments)).toHaveLength(0);
  });

  it('rolls the whole order back if any part fails', async () => {
    await seedCombo({ comboKey: 'mega_prime_48k', advertised: 6160, priceMxn: 750, recipe: [5600] });
    const first = await createOrder({ store: store() }, input());
    expect(first.ok).toBe(true);

    // Force a collision on the unique order number by reusing it explicitly.
    const reused = (first as { order: { orderNumber: string } }).order.orderNumber;
    await createOrder(
      { store: store(), generateOrderNumber: () => reused },
      input({ playerId: '9999999999' }),
    );

    // The retry allocates a fresh number rather than leaving a partial write.
    const all = await db.select().from(orders);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((o) => o.orderNumber)).size).toBe(2);
    expect(await db.select().from(orderItems)).toHaveLength(2);
  });
});

describe.skipIf(!PG_AVAILABLE)('the Mega Oferta cap, end to end', () => {
  beforeEach(async () => {
    if (!PG_AVAILABLE) return;
    await seedCombo({
      comboKey: 'mega_10',
      advertised: 110,
      priceMxn: 10,
      recipe: [100],
      maxPerPlayer: 1,
    });
  });

  it('allows the first purchase', async () => {
    const result = await createOrder({ store: store() }, input({ comboKey: 'mega_10' }));
    expect(result.ok).toBe(true);
  });

  it('refuses the second for the same player', async () => {
    await createOrder({ store: store() }, input({ comboKey: 'mega_10' }));
    const second = await createOrder({ store: store() }, input({ comboKey: 'mega_10' }));

    expect(second).toMatchObject({ failure: { code: 'PLAYER_LIMIT_REACHED' } });
    expect(await db.select().from(orders)).toHaveLength(1);
  });

  it('allows a different player', async () => {
    await createOrder({ store: store() }, input({ comboKey: 'mega_10' }));
    const other = await createOrder(
      { store: store() },
      input({ comboKey: 'mega_10', playerId: '1234567890' }),
    );
    expect(other.ok).toBe(true);
  });

  it('frees the cap once the first order is cancelled', async () => {
    await createOrder({ store: store() }, input({ comboKey: 'mega_10' }));
    await db.update(orders).set({ status: 'cancelled' });

    const again = await createOrder({ store: store() }, input({ comboKey: 'mega_10' }));
    expect(again.ok).toBe(true);
  });
});

describe.skipIf(!PG_AVAILABLE)('availability from the database', () => {
  it('refuses an inactive combo on the storefront', async () => {
    await seedCombo({
      comboKey: 'mega_prime_48k',
      advertised: 6160,
      priceMxn: 750,
      recipe: [5600],
      active: false,
    });

    expect(await createOrder({ store: store() }, input())).toMatchObject({
      failure: { code: 'COMBO_INACTIVE' },
    });
  });

  it('refuses when the whole campaign is switched off', async () => {
    await seedCombo({
      comboKey: 'mega_prime_48k',
      advertised: 6160,
      priceMxn: 750,
      recipe: [5600],
      campaignActive: false,
    });

    expect(await createOrder({ store: store() }, input())).toMatchObject({
      failure: { code: 'COMBO_INACTIVE' },
    });
  });

  it('still lets an admin place it', async () => {
    await seedCombo({
      comboKey: 'mega_prime_48k',
      advertised: 6160,
      priceMxn: 750,
      recipe: [5600],
      active: false,
    });

    expect((await createOrder({ store: store() }, input({ source: 'admin' }))).ok).toBe(true);
  });

  it('refuses when the catalog has no synced cost', async () => {
    await seedCombo({
      comboKey: 'mega_prime_48k',
      advertised: 6160,
      priceMxn: 750,
      recipe: [5600],
      costUsd: null,
    });

    expect(await createOrder({ store: store() }, input())).toMatchObject({
      failure: { code: 'CATALOG_NOT_SYNCED' },
    });
  });
});

describe.skipIf(!PG_AVAILABLE)('handover to the worker', () => {
  it('an order is invisible to the queue until it is paid', async () => {
    await seedCombo({ comboKey: 'mega_prime_48k', advertised: 6160, priceMxn: 750, recipe: [5600] });
    await createOrder({ store: store() }, input());

    // pending_payment must never be fulfilled — that is the whole point.
    expect(await new DrizzleOrderQueue(db).claimNext(300_000)).toBeNull();
  });

  it('becomes claimable once marked paid', async () => {
    await seedCombo({ comboKey: 'mega_prime_48k', advertised: 6160, priceMxn: 750, recipe: [5600] });
    await createOrder({ store: store() }, input());

    // What the comprobante approval will do.
    await db.update(orders).set({ status: 'payment_confirmed' });
    await db.update(payments).set({ status: 'paid', paidAt: new Date() });

    const claimed = await new DrizzleOrderQueue(db).claimNext(300_000);
    expect(claimed).not.toBeNull();
    expect(claimed?.recovered).toBe(false);
  });
});
