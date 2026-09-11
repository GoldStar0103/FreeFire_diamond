/**
 * Which orders get reported to Meta, against real Postgres — including the
 * migration that added the columns.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { orders } from '../schema.js';
import { DrizzleConversionStore } from './conversion-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_conversion_test';

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
  await db.execute(raw`TRUNCATE orders RESTART IDENTITY CASCADE`);
});

const HOUR = 3_600_000;
let n = 0;

async function insert(overrides: Partial<typeof orders.$inferInsert> = {}) {
  n++;
  const [row] = await db
    .insert(orders)
    .values({
      orderNumber: `LU-260915-${String(n).padStart(4, '0')}`,
      playerId: `72885670${String(n).padStart(2, '0')}`,
      comboKey: 'pack_insano',
      comboSnapshot: {},
      priceMxnCents: 86_000,
      status: 'completed',
      paidAt: new Date(Date.now() - HOUR),
      userAgent: 'Mozilla/5.0 (iPhone)',
      fbp: 'fb.1.1757000000000.42',
      ...overrides,
    })
    .returning();
  return row!;
}

const find = (store: DrizzleConversionStore) =>
  store.findUnreported({ paidAfter: new Date(Date.now() - 7 * 24 * HOUR), maxAttempts: 5, limit: 25 });

describe.skipIf(!PG_AVAILABLE)('findUnreported', () => {
  it('returns paid storefront orders with what Meta needs to match them', async () => {
    const paid = await insert();
    const [found] = await find(new DrizzleConversionStore(db));

    expect(found).toMatchObject({
      orderId: paid.id,
      eventId: paid.eventId,
      comboKey: 'pack_insano',
      priceMxnCents: 86_000,
      fbp: 'fb.1.1757000000000.42',
      attempts: 0,
    });
  });

  it('skips what is not a reportable sale', async () => {
    await insert({ status: 'pending_payment', paidAt: null }); // not paid
    await insert({ userAgent: null }); // WhatsApp sale from the panel
    await insert({ status: 'cancelled' }); // refunded
    await insert({ paidAt: new Date(Date.now() - 8 * 24 * HOUR) }); // too old for Meta
    await insert({ capiSentAt: new Date() }); // already sent
    await insert({ capiAttempts: 5 }); // gave up

    expect(await find(new DrizzleConversionStore(db))).toEqual([]);
  });

  it('marks reported orders so they are never sent twice', async () => {
    const store = new DrizzleConversionStore(db);
    const paid = await insert();

    await store.markReported(paid.id, new Date());
    expect(await find(store)).toEqual([]);
  });

  it('counts failed attempts until the budget runs out', async () => {
    const store = new DrizzleConversionStore(db);
    const paid = await insert({ capiAttempts: 3 });

    await store.recordFailedAttempt(paid.id);
    expect((await find(store))[0]?.attempts).toBe(4);

    await store.recordFailedAttempt(paid.id);
    expect(await find(store)).toEqual([]);
    const [row] = await db.select().from(orders).where(eq(orders.id, paid.id));
    expect(row?.capiAttempts).toBe(5);
  });
});
