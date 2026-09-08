/**
 * Integration tests against a real Postgres.
 *
 * Everything else in this repo runs against in-memory fakes, which is the right
 * default — but three claims cannot be verified that way, and all three are
 * load-bearing:
 *
 *   1. The partial unique index really does reject a second Mega Oferta.
 *   2. `pg_advisory_lock` really does serialise across pooled connections.
 *   3. `numeric(12,4)` really does survive the round trip without float drift.
 *
 * Postgres is booted from npm binaries — no Docker, no system install.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { ProviderSimulator, type UsdTenK } from '@levelup/provider';
import { fulfillOrder, InMemoryLock } from '@levelup/engine';
import { MemoryAlerter } from '@levelup/engine/testing';
import { createDb, type Database } from '../index.js';
import { baseProducts, campaigns, comboItems, combos, orderItems, orders, paymentEvents } from '../schema.js';
import { DrizzleFulfillmentStore } from './fulfillment-store.js';
import { PostgresAdvisoryLock } from './advisory-lock.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');

/**
 * Points at a Postgres managed outside the test run — `scripts/pg.mjs start`
 * locally, a service container in CI, the client's VPS on staging.
 *
 * Booting Postgres in-process was the first attempt and does not work here:
 * the server refuses to start under a Windows administrator account, and
 * `pg_ctl` (which drops privileges) holds stdout open for the daemon's
 * lifetime. Managing it out of band sidesteps both and matches how CI runs.
 */
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_test';

/** Skip rather than fail when no database is reachable, so `pnpm -r test` stays green. */
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

if (!PG_AVAILABLE) {
  console.warn(
    `\n  [integration] Skipped — no Postgres at ${BASE_URL}.` +
      `\n  Start one with: node scripts/pg.mjs start\n`,
  );
}

let db: Database;
let client: ReturnType<typeof createDb>['client'];

beforeAll(async () => {
  if (!PG_AVAILABLE) return;

  // Recreate from scratch so the migration is exercised on a virgin database
  // every run — the same path the client's VPS will take on first deploy.
  const admin = postgres(`${BASE_URL}/postgres`, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  ({ db, client } = createDb(`${BASE_URL}/${TEST_DB}`, { max: 10 }));
  await migrate(db, { migrationsFolder: MIGRATIONS });
}, 180_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
}, 60_000);

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(
    raw`TRUNCATE orders, order_items, payment_events, combo_items, combos, campaigns, base_products RESTART IDENTITY CASCADE`,
  );
});

// ── fixtures ──────────────────────────────────────────────────────────────────

const snapshot = { name: 'Mega Oferta 110', advertised: 110, recipe: [100] };

async function insertOrder(overrides: {
  orderNumber: string;
  playerId: string;
  comboKey: string;
  status?: 'pending_payment' | 'payment_confirmed' | 'cancelled' | 'completed';
}) {
  const [row] = await db
    .insert(orders)
    .values({
      orderNumber: overrides.orderNumber,
      playerId: overrides.playerId,
      comboKey: overrides.comboKey,
      comboSnapshot: snapshot,
      priceMxnCents: 1_000,
      status: overrides.status ?? 'pending_payment',
    })
    .returning();
  return row!;
}

// ── the Mega Oferta limit ─────────────────────────────────────────────────────

describe.skipIf(!PG_AVAILABLE)('one_mega_oferta_per_player (partial unique index)', () => {
  it('rejects a second Mega Oferta for the same player', async () => {
    await insertOrder({ orderNumber: 'LU-1', playerId: '7288567050', comboKey: 'mega_10' });

    // The application check cannot hold this line on its own: OXXO settles
    // hours after checkout, so two orders can race past validation. This is
    // the constraint that actually stops it.
    await expect(
      insertOrder({ orderNumber: 'LU-2', playerId: '7288567050', comboKey: 'mega_10' }),
    ).rejects.toThrow(/one_mega_oferta_per_player|duplicate key/i);
  });

  it('allows a different player', async () => {
    await insertOrder({ orderNumber: 'LU-1', playerId: '7288567050', comboKey: 'mega_10' });
    await expect(
      insertOrder({ orderNumber: 'LU-2', playerId: '9999999999', comboKey: 'mega_10' }),
    ).resolves.toBeDefined();
  });

  it('does not constrain any other combo', async () => {
    await insertOrder({ orderNumber: 'LU-1', playerId: '7288567050', comboKey: 'chidos_1700' });
    await expect(
      insertOrder({ orderNumber: 'LU-2', playerId: '7288567050', comboKey: 'chidos_1700' }),
    ).resolves.toBeDefined();
  });

  it('frees the slot once the first order is cancelled', async () => {
    const first = await insertOrder({
      orderNumber: 'LU-1',
      playerId: '7288567050',
      comboKey: 'mega_10',
    });
    await db.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, first.id));

    // A cancelled order should not permanently burn the customer's one offer.
    await expect(
      insertOrder({ orderNumber: 'LU-2', playerId: '7288567050', comboKey: 'mega_10' }),
    ).resolves.toBeDefined();
  });

  it('still blocks while the first order is merely completed', async () => {
    const first = await insertOrder({
      orderNumber: 'LU-1',
      playerId: '7288567050',
      comboKey: 'mega_10',
    });
    await db.update(orders).set({ status: 'completed' }).where(eq(orders.id, first.id));

    await expect(
      insertOrder({ orderNumber: 'LU-2', playerId: '7288567050', comboKey: 'mega_10' }),
    ).rejects.toThrow();
  });
});

// ── webhook dedupe ────────────────────────────────────────────────────────────

describe.skipIf(!PG_AVAILABLE)('payment_events dedupe', () => {
  it('rejects a duplicate webhook delivery', async () => {
    const event = { gateway: 'conekta', gatewayEventId: 'evt_123', payload: { ok: true } };
    await db.insert(paymentEvents).values(event);

    // Gateways retry. The constraint is the dedupe — not application logic.
    await expect(db.insert(paymentEvents).values(event)).rejects.toThrow(/duplicate key/i);
  });

  it('allows the same event id from a different gateway', async () => {
    await db.insert(paymentEvents).values({
      gateway: 'conekta',
      gatewayEventId: 'evt_123',
      payload: {},
    });
    await expect(
      db.insert(paymentEvents).values({ gateway: 'paypal', gatewayEventId: 'evt_123', payload: {} }),
    ).resolves.toBeDefined();
  });
});

// ── the advisory lock ─────────────────────────────────────────────────────────

describe.skipIf(!PG_AVAILABLE)('PostgresAdvisoryLock', () => {
  it('serialises concurrent holders across pooled connections', async () => {
    const lock = new PostgresAdvisoryLock(client);
    const observed: string[] = [];

    await Promise.all(
      ['a', 'b', 'c'].map((tag) =>
        lock.withLock('test:serialise', async () => {
          observed.push(`${tag}:enter`);
          await new Promise((r) => setTimeout(r, 40));
          observed.push(`${tag}:exit`);
        }),
      ),
    );

    for (let i = 0; i < observed.length; i += 2) {
      const tag = observed[i]!.split(':')[0];
      expect(observed[i]).toBe(`${tag}:enter`);
      expect(observed[i + 1]).toBe(`${tag}:exit`);
    }
  }, 30_000);

  it('releases the lock so the next caller can take it', async () => {
    const lock = new PostgresAdvisoryLock(client);
    await lock.withLock('test:release', async () => 'first');
    // If release ran on a different connection than acquire, this would hang.
    await expect(lock.withLock('test:release', async () => 'second')).resolves.toBe('second');
  }, 30_000);

  it('releases even when the work throws', async () => {
    const lock = new PostgresAdvisoryLock(client);
    await expect(
      lock.withLock('test:throw', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(lock.withLock('test:throw', async () => 'ok')).resolves.toBe('ok');
  }, 30_000);

  it('tryWithLock returns null instead of blocking when held', async () => {
    const lock = new PostgresAdvisoryLock(client);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));

    const holder = lock.withLock('test:try', async () => {
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));

    // This is what lets the recovery cron skip while a combo is mid-flight.
    expect(await lock.tryWithLock('test:try', async () => 'ran')).toBeNull();

    release();
    await holder;
    expect(await lock.tryWithLock('test:try', async () => 'ran')).toBe('ran');
  }, 30_000);
});

// ── the store, against real rows ──────────────────────────────────────────────

async function seedFulfillableOrder(itemCount: number, costUsd = '27.5000') {
  const [campaign] = await db
    .insert(campaigns)
    .values({ key: 'mega_prime', name: 'PACKS MEGA PRIME' })
    .returning();
  const [combo] = await db
    .insert(combos)
    .values({
      campaignId: campaign!.id,
      key: 'mega_prime_48k',
      name: 'Mega Prime 48k',
      priceMxnCents: 585_000,
      advertisedDiamonds: 48_800,
    })
    .returning();
  const [product] = await db
    .insert(baseProducts)
    .values({
      providerProductId: 'd5600',
      endpointKind: 'pins_recharge',
      name: 'Free Fire 5600',
      diamondsBase: 5600,
      costUsd,
    })
    .returning();

  await db
    .insert(comboItems)
    .values(
      Array.from({ length: itemCount }, (_, i) => ({
        comboId: combo!.id,
        baseProductId: product!.id,
        sequence: i,
      })),
    );

  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: 'LU-000900',
      playerId: '7288567050',
      comboId: combo!.id,
      comboKey: 'mega_prime_48k',
      comboSnapshot: { name: 'Mega Prime 48k', advertised: 48_800 },
      priceMxnCents: 585_000,
      status: 'payment_confirmed',
    })
    .returning();

  await db.insert(orderItems).values(
    Array.from({ length: itemCount }, (_, i) => ({
      orderId: order!.id,
      sequence: i,
      baseProductId: product!.id,
      providerProductId: 'd5600',
      diamondsBase: 5600,
      costUsd,
    })),
  );

  return order!;
}

describe.skipIf(!PG_AVAILABLE)('DrizzleFulfillmentStore', () => {
  it('loads an order with its items in recipe sequence', async () => {
    const order = await seedFulfillableOrder(8);
    const store = new DrizzleFulfillmentStore(db);

    const loaded = await store.loadOrder(order.id);

    expect(loaded?.items).toHaveLength(8);
    expect(loaded?.items.map((i) => i.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // numeric(12,4) -> string -> UsdTenK, with no float in between.
    expect(loaded?.items[0]?.costUsd).toBe(275_000);
  });

  it('returns null for an unknown order', async () => {
    expect(await new DrizzleFulfillmentStore(db).loadOrder(crypto.randomUUID())).toBeNull();
  });

  it('records intent and increments the attempt count', async () => {
    const order = await seedFulfillableOrder(1);
    const store = new DrizzleFulfillmentStore(db);
    const loaded = await store.loadOrder(order.id);

    await store.markItemSending(loaded!.items[0]!.id, 1_500_000 as UsdTenK);

    const after = await store.loadOrder(order.id);
    expect(after?.items[0]?.status).toBe('sending');
    expect(after?.items[0]?.attemptCount).toBe(1);
    expect(after?.items[0]?.walletBeforeUsd).toBe(1_500_000);
  });

  it('refuses to dispatch an item another worker already holds', async () => {
    const order = await seedFulfillableOrder(1);
    const store = new DrizzleFulfillmentStore(db);
    const itemId = (await store.loadOrder(order.id))!.items[0]!.id;

    await store.markItemSending(itemId, 1_500_000 as UsdTenK);

    // Second dispatch matches zero rows — this is what stops a double delivery
    // if two workers ever race past the advisory lock.
    await expect(store.markItemSending(itemId, 1_500_000 as UsdTenK)).rejects.toThrow(
      /not in a dispatchable state/,
    );
  });

  it('round-trips a settlement', async () => {
    const order = await seedFulfillableOrder(1);
    const store = new DrizzleFulfillmentStore(db);
    const itemId = (await store.loadOrder(order.id))!.items[0]!.id;

    await store.markItemSending(itemId, 1_500_000 as UsdTenK);
    await store.settleItem(itemId, {
      status: 'succeeded',
      providerTransactionId: '4242',
      providerReference: 'REF-1',
      walletAfterUsd: 1_225_000 as UsdTenK,
      resolvedBy: 'wallet_delta',
    });

    const after = await store.loadOrder(order.id);
    expect(after?.items[0]?.status).toBe('succeeded');
    expect(after?.items[0]?.providerReference).toBe('REF-1');
  });

  it('stamps completedAt only when the order completes', async () => {
    const order = await seedFulfillableOrder(1);
    const store = new DrizzleFulfillmentStore(db);

    await store.updateOrderStatus(order.id, 'processing');
    let [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row?.completedAt).toBeNull();

    await store.updateOrderStatus(order.id, 'completed');
    [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row?.completedAt).toBeInstanceOf(Date);
  });

  it('throws rather than fulfilling an item with no synced cost', async () => {
    const order = await seedFulfillableOrder(1);
    await db.update(orderItems).set({ costUsd: null }).where(eq(orderItems.orderId, order.id));

    await expect(new DrizzleFulfillmentStore(db).loadOrder(order.id)).rejects.toThrow(
      /catalog sync/,
    );
  });
});

// ── the whole stack ───────────────────────────────────────────────────────────

describe.skipIf(!PG_AVAILABLE)('full engine against real Postgres', () => {
  it('fulfils an 8-call combo and persists every item', async () => {
    const order = await seedFulfillableOrder(8);
    const sim = new ProviderSimulator({ initialBalanceUsd: 500, prices: { d5600: 27.5 } });
    sim.program({ mode: 'succeed' });

    const result = await fulfillOrder(
      {
        store: new DrizzleFulfillmentStore(db),
        provider: sim,
        lock: new PostgresAdvisoryLock(client),
        alerter: new MemoryAlerter(),
        config: { interCallDelayMs: 0 },
      },
      order.id,
    );

    expect(result.finalStatus).toBe('completed');
    expect(result.delivered).toBe(8);
    expect(sim.deliveryCount).toBe(8);

    const rows = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.status === 'succeeded')).toBe(true);
    expect(rows.every((r) => r.walletBeforeUsd !== null)).toBe(true);
  }, 60_000);

  it('recovers a mid-combo timeout without double-delivering, in the database', async () => {
    const order = await seedFulfillableOrder(8);
    const sim = new ProviderSimulator({ initialBalanceUsd: 500, prices: { d5600: 27.5 } });
    sim.program(
      { mode: 'succeed' },
      { mode: 'succeed' },
      { mode: 'succeed' },
      { mode: 'timeout', charged: true },
      { mode: 'succeed' },
    );

    const result = await fulfillOrder(
      {
        store: new DrizzleFulfillmentStore(db),
        provider: sim,
        lock: new PostgresAdvisoryLock(client),
        alerter: new MemoryAlerter(),
        config: { interCallDelayMs: 0 },
      },
      order.id,
    );

    expect(result.finalStatus).toBe('completed');
    expect(sim.deliveryCount).toBe(8); // never nine

    const rows = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(orderItems.sequence);

    expect(rows.every((r) => r.status === 'succeeded')).toBe(true);
    // The audit trail records HOW the ambiguous call was resolved.
    expect(rows[3]?.resolvedBy).toBe('wallet_delta');
    expect(rows[0]?.resolvedBy).toBe('response');
  }, 60_000);
});
