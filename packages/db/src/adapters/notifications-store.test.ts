/**
 * The bell's notification feed, against real Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { playerProfiles } from '../schema.js';
import { createNotification, listMyNotifications, markNotificationsRead } from './notifications-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_notifications_test';

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
  await db.execute(raw`TRUNCATE notifications, player_profiles RESTART IDENTITY CASCADE`);
});

async function seedProfile(playerId = '100001') {
  const [profile] = await db
    .insert(playerProfiles)
    .values({ playerId, email: `${playerId}@test.levelup` })
    .returning();
  return profile!;
}

describe.skipIf(!PG_AVAILABLE)('notifications', () => {
  it('starts empty', async () => {
    const profile = await seedProfile();
    expect(await listMyNotifications(db, profile.id)).toEqual({ unreadCount: 0, items: [] });
  });

  it('counts only unread, independent of the items list size', async () => {
    const profile = await seedProfile();
    await createNotification(db, {
      playerProfileId: profile.id,
      type: 'order_delivered',
      title: 'Done!',
      message: '520 diamantes entregados',
    });
    await createNotification(db, {
      playerProfileId: profile.id,
      type: 'payment_confirmed',
      title: 'Pago confirmado',
      message: 'Orden #LU-1',
    });

    const { unreadCount, items } = await listMyNotifications(db, profile.id);
    expect(unreadCount).toBe(2);
    expect(items).toHaveLength(2);
    // Newest first.
    expect(items[0]?.type).toBe('payment_confirmed');
  });

  it('never leaks another profile\'s notifications', async () => {
    const mine = await seedProfile('100001');
    const theirs = await seedProfile('100002');
    await createNotification(db, { playerProfileId: theirs.id, type: 'refund', title: 'x', message: 'y' });

    expect(await listMyNotifications(db, mine.id)).toEqual({ unreadCount: 0, items: [] });
  });

  it('marks specific ids read without touching the rest', async () => {
    const profile = await seedProfile();
    await createNotification(db, { playerProfileId: profile.id, type: 'order_created', title: 'a', message: 'a' });
    await createNotification(db, { playerProfileId: profile.id, type: 'order_delivered', title: 'b', message: 'b' });
    const [{ items }] = [await listMyNotifications(db, profile.id)];

    await markNotificationsRead(db, profile.id, [items[0]!.id]);

    const after = await listMyNotifications(db, profile.id);
    expect(after.unreadCount).toBe(1);
    expect(after.items.find((n) => n.id === items[0]!.id)?.readAt).not.toBeNull();
    expect(after.items.find((n) => n.id === items[1]!.id)?.readAt).toBeNull();
  });

  it('"all" marks every unread notification read', async () => {
    const profile = await seedProfile();
    await createNotification(db, { playerProfileId: profile.id, type: 'order_created', title: 'a', message: 'a' });
    await createNotification(db, { playerProfileId: profile.id, type: 'order_delivered', title: 'b', message: 'b' });

    await markNotificationsRead(db, profile.id, 'all');

    expect((await listMyNotifications(db, profile.id)).unreadCount).toBe(0);
  });

  it('cannot mark another profile\'s notification read', async () => {
    const mine = await seedProfile('100001');
    const theirs = await seedProfile('100002');
    await createNotification(db, { playerProfileId: theirs.id, type: 'refund', title: 'x', message: 'y' });
    const [{ items }] = [await listMyNotifications(db, theirs.id)];

    await markNotificationsRead(db, mine.id, [items[0]!.id]);

    expect((await listMyNotifications(db, theirs.id)).unreadCount).toBe(1);
  });
});
