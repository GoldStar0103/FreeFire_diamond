/**
 * Queue claim semantics, against real Postgres.
 *
 * `FOR UPDATE SKIP LOCKED` and the staleness window are database behaviour;
 * a fake would only test my assumptions about them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { orders } from '../schema.js';
import { DrizzleOrderQueue } from './order-queue.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_queue_test';

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
  ({ db, client } = createDb(`${BASE_URL}/${TEST_DB}`, { max: 8 }));
  await migrate(db, { migrationsFolder: MIGRATIONS });
}, 180_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
}, 30_000);

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(raw`TRUNCATE orders RESTART IDENTITY CASCADE`);
});

type Status = 'pending_payment' | 'payment_confirmed' | 'processing' | 'partially_delivered' | 'completed' | 'needs_review';

async function seedOrder(orderNumber: string, status: Status, ageSeconds = 0) {
  const [row] = await db
    .insert(orders)
    .values({
      orderNumber,
      playerId: '7288567050',
      comboKey: 'mega_prime_48k',
      comboSnapshot: { name: 'Mega Prime 48k' },
      priceMxnCents: 585_000,
      status,
      createdAt: raw`now() - make_interval(secs => ${ageSeconds})`,
      updatedAt: raw`now() - make_interval(secs => ${ageSeconds})`,
    })
    .returning();
  return row!;
}

describe.skipIf(!PG_AVAILABLE)('claimNext', () => {
  it('claims a paid order and marks it processing', async () => {
    await seedOrder('LU-1', 'payment_confirmed');

    const claimed = await new DrizzleOrderQueue(db).claimNext(300_000);

    expect(claimed?.orderNumber).toBe('LU-1');
    const [row] = await db.select().from(orders).where(eq(orders.orderNumber, 'LU-1'));
    expect(row?.status).toBe('processing');
  });

  it('claims a partially delivered order so it can finish', async () => {
    await seedOrder('LU-1', 'partially_delivered');
    expect((await new DrizzleOrderQueue(db).claimNext(300_000))?.orderNumber).toBe('LU-1');
  });

  it('returns null when there is nothing to do', async () => {
    await seedOrder('LU-1', 'pending_payment');
    await seedOrder('LU-2', 'completed');
    await seedOrder('LU-3', 'needs_review');

    expect(await new DrizzleOrderQueue(db).claimNext(300_000)).toBeNull();
  });

  it('never hands the same order to two workers', async () => {
    await seedOrder('LU-1', 'payment_confirmed');

    // Two independent connections racing for one row.
    const [a, b] = await Promise.all([
      new DrizzleOrderQueue(db).claimNext(300_000),
      new DrizzleOrderQueue(db).claimNext(300_000),
    ]);

    const claimed = [a, b].filter(Boolean);
    expect(claimed).toHaveLength(1);
  });

  it('hands two workers different orders rather than blocking', async () => {
    await seedOrder('LU-1', 'payment_confirmed', 20);
    await seedOrder('LU-2', 'payment_confirmed', 10);

    const [a, b] = await Promise.all([
      new DrizzleOrderQueue(db).claimNext(300_000),
      new DrizzleOrderQueue(db).claimNext(300_000),
    ]);

    expect(new Set([a?.orderNumber, b?.orderNumber]).size).toBe(2);
  });

  it('takes the oldest order first', async () => {
    await seedOrder('LU-new', 'payment_confirmed', 10);
    await seedOrder('LU-old', 'payment_confirmed', 600);

    expect((await new DrizzleOrderQueue(db).claimNext(300_000))?.orderNumber).toBe('LU-old');
  });

  it('leaves a healthy in-flight order alone', async () => {
    // Another worker is mid-combo on this one right now.
    await seedOrder('LU-1', 'processing', 5);

    expect(await new DrizzleOrderQueue(db).claimNext(300_000)).toBeNull();
  });

  it('recovers an order whose worker died', async () => {
    await seedOrder('LU-1', 'processing', 900);

    const claimed = await new DrizzleOrderQueue(db).claimNext(300_000);

    expect(claimed?.orderNumber).toBe('LU-1');
    // Flagged so the worker can log that this was a recovery, not a fresh claim.
    expect(claimed?.recovered).toBe(true);
  });

  it('does not report a fresh claim as recovered', async () => {
    await seedOrder('LU-1', 'payment_confirmed');
    expect((await new DrizzleOrderQueue(db).claimNext(300_000))?.recovered).toBe(false);
  });

  it('refreshes updated_at so a claimed order stops looking stale', async () => {
    await seedOrder('LU-1', 'processing', 900);
    await new DrizzleOrderQueue(db).claimNext(300_000);

    // Immediately re-claiming would mean two workers on one order.
    expect(await new DrizzleOrderQueue(db).claimNext(300_000)).toBeNull();
  });
});

describe.skipIf(!PG_AVAILABLE)('depth', () => {
  it('counts only the statuses that need attention', async () => {
    await seedOrder('LU-1', 'payment_confirmed');
    await seedOrder('LU-2', 'payment_confirmed');
    await seedOrder('LU-3', 'processing');
    await seedOrder('LU-4', 'needs_review');
    await seedOrder('LU-5', 'completed');
    await seedOrder('LU-6', 'pending_payment');

    expect(await new DrizzleOrderQueue(db).depth()).toEqual({
      payment_confirmed: 2,
      processing: 1,
      needs_review: 1,
    });
  });

  it('is empty when nothing is outstanding', async () => {
    expect(await new DrizzleOrderQueue(db).depth()).toEqual({});
  });
});
