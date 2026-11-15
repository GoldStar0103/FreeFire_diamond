/**
 * `DrizzleExpiryReminderStore` against real Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { notifications, orders, payments, playerProfiles } from '../schema.js';
import { DrizzleExpiryReminderStore } from './expiry-reminder-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_expiry_reminder_test';

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
    raw`TRUNCATE orders, order_items, payments, player_profiles, notifications RESTART IDENTITY CASCADE`,
  );
});

async function seedProfile(playerId = '100001') {
  const [profile] = await db
    .insert(playerProfiles)
    .values({ playerId, email: `${playerId}@test.levelup` })
    .returning();
  return profile!;
}

/** A pending payment, positioned at a chosen distance from expiry. */
async function seedPending(options: {
  orderNumber: string;
  playerProfileId?: string | null;
  expiresInSeconds: number;
  paymentStatus?: 'pending' | 'under_review';
  orderStatus?: 'pending_payment' | 'cancelled';
}) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: options.orderNumber,
      playerId: '7288567050',
      playerProfileId: options.playerProfileId ?? null,
      comboKey: 'mega_10',
      comboSnapshot: { name: 'Mega Oferta 110' },
      priceMxnCents: 1_000,
      status: options.orderStatus ?? 'pending_payment',
    })
    .returning();

  await db.insert(payments).values({
    orderId: order!.id,
    method: 'transfer_manual',
    status: options.paymentStatus ?? 'pending',
    amountExpectedCents: 1_000,
    expiresAt: raw`now() + make_interval(secs => ${options.expiresInSeconds})`,
  });

  return order!;
}

const store = () => new DrizzleExpiryReminderStore(db);
const WINDOW_30M = 30 * 60_000;

describe.skipIf(!PG_AVAILABLE)('findExpiringPayments', () => {
  it('finds a pending order with an account, closing inside the window', async () => {
    const profile = await seedProfile();
    const order = await seedPending({
      orderNumber: 'LU-260101-AAAA',
      playerProfileId: profile.id,
      expiresInSeconds: 10 * 60,
    });

    const found = await store().findExpiringPayments(new Date(), WINDOW_30M, 25);
    expect(found).toEqual([{ orderId: order.id, orderNumber: order.orderNumber }]);
  });

  it('ignores a guest order with no account to notify', async () => {
    await seedPending({ orderNumber: 'LU-260101-AAAA', expiresInSeconds: 10 * 60 });
    expect(await store().findExpiringPayments(new Date(), WINDOW_30M, 25)).toHaveLength(0);
  });

  it('ignores one that is not close to expiring yet', async () => {
    const profile = await seedProfile();
    await seedPending({ orderNumber: 'LU-260101-AAAA', playerProfileId: profile.id, expiresInSeconds: 2 * 60 * 60 });
    expect(await store().findExpiringPayments(new Date(), WINDOW_30M, 25)).toHaveLength(0);
  });

  it('ignores one that has already expired', async () => {
    const profile = await seedProfile();
    await seedPending({ orderNumber: 'LU-260101-AAAA', playerProfileId: profile.id, expiresInSeconds: -60 });
    expect(await store().findExpiringPayments(new Date(), WINDOW_30M, 25)).toHaveLength(0);
  });

  it('ignores one already under review', async () => {
    const profile = await seedProfile();
    await seedPending({
      orderNumber: 'LU-260101-AAAA',
      playerProfileId: profile.id,
      expiresInSeconds: 10 * 60,
      paymentStatus: 'under_review',
    });
    expect(await store().findExpiringPayments(new Date(), WINDOW_30M, 25)).toHaveLength(0);
  });

  it('ignores one already reminded', async () => {
    const profile = await seedProfile();
    const order = await seedPending({
      orderNumber: 'LU-260101-AAAA',
      playerProfileId: profile.id,
      expiresInSeconds: 10 * 60,
    });

    await store().sendReminder(order.id);
    expect(await store().findExpiringPayments(new Date(), WINDOW_30M, 25)).toHaveLength(0);
  });
});

describe.skipIf(!PG_AVAILABLE)('sendReminder', () => {
  it('rings the bell exactly once, even called twice', async () => {
    const profile = await seedProfile();
    const order = await seedPending({
      orderNumber: 'LU-260101-AAAA',
      playerProfileId: profile.id,
      expiresInSeconds: 10 * 60,
    });

    await store().sendReminder(order.id);
    await store().sendReminder(order.id);

    const rows = await db.select().from(notifications).where(eq(notifications.orderId, order.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'order_expiring', playerProfileId: profile.id });
  });

  it('does nothing for a guest order', async () => {
    const order = await seedPending({ orderNumber: 'LU-260101-AAAA', expiresInSeconds: 10 * 60 });
    await store().sendReminder(order.id);
    expect(await db.select().from(notifications).where(eq(notifications.orderId, order.id))).toHaveLength(0);
  });
});
