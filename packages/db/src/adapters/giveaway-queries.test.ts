/**
 * Storefront/account read models (`giveaway-queries.ts`) against real Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { adminUsers, giveawayEntries, giveaways, playerProfiles } from '../schema.js';
import { getMyEntry, getOpenGiveaway, listMyGiveawayEntries, listOpenGiveaways } from './giveaway-queries.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_giveaway_queries_test';

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
let adminId: string;

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
  await db.execute(raw`TRUNCATE giveaways, player_profiles, admin_users RESTART IDENTITY CASCADE`);
  const [admin] = await db
    .insert(adminUsers)
    .values({ email: `admin-${Math.random()}@test.com`, passwordHash: 'x' })
    .returning();
  adminId = admin!.id;
});

async function seedPlayer() {
  const playerId = `p-${Math.random().toString(36).slice(2)}`;
  const [profile] = await db
    .insert(playerProfiles)
    .values({ playerId, email: `${playerId}@test.levelup` })
    .returning();
  return profile!;
}

async function seedGiveaway(overrides: Partial<typeof giveaways.$inferInsert> = {}) {
  const [row] = await db
    .insert(giveaways)
    .values({
      title: 'Sorteo',
      description: 'd',
      prizeDescription: 'p',
      entryCostTickets: 10,
      scheduleType: 'daily',
      minEntries: 0,
      opensAt: new Date('2026-11-01T00:00:00Z'),
      closesAt: new Date('2026-11-08T00:00:00Z'),
      status: 'open',
      createdByAdminId: adminId,
      ...overrides,
    })
    .returning();
  return row!;
}

const NOW = new Date('2026-11-05T00:00:00Z');

describe.skipIf(!PG_AVAILABLE)('listOpenGiveaways / getOpenGiveaway', () => {
  it('lists only open giveaways inside their entry window, with total entries', async () => {
    const open = await seedGiveaway();
    const player = await seedPlayer();
    await db.insert(giveawayEntries).values({ giveawayId: open.id, playerProfileId: player.id, entryCount: 4, ticketsSpent: 40 });

    await seedGiveaway({ status: 'draft' });
    await seedGiveaway({ status: 'open', closesAt: new Date('2026-10-01T00:00:00Z') });
    await seedGiveaway({ status: 'open', opensAt: new Date('2026-12-01T00:00:00Z'), closesAt: new Date('2026-12-08T00:00:00Z') });

    const list = await listOpenGiveaways(db, NOW);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: open.id, totalEntryCount: 4 });
  });

  it('getOpenGiveaway returns null for a closed or out-of-window giveaway', async () => {
    const closed = await seedGiveaway({ status: 'closed_pending_draw' });
    expect(await getOpenGiveaway(db, closed.id, NOW)).toBeNull();

    const notYetOpen = await seedGiveaway({ opensAt: new Date('2026-12-01T00:00:00Z'), closesAt: new Date('2026-12-08T00:00:00Z') });
    expect(await getOpenGiveaway(db, notYetOpen.id, NOW)).toBeNull();
  });

  it('getOpenGiveaway returns the giveaway when open and in window', async () => {
    const open = await seedGiveaway();
    const found = await getOpenGiveaway(db, open.id, NOW);
    expect(found).toMatchObject({ id: open.id, totalEntryCount: 0 });
  });
});

describe.skipIf(!PG_AVAILABLE)('getMyEntry / listMyGiveawayEntries', () => {
  it('getMyEntry returns null when the player has not entered', async () => {
    const open = await seedGiveaway();
    const player = await seedPlayer();
    expect(await getMyEntry(db, open.id, player.id)).toBeNull();
  });

  it('getMyEntry returns the entry totals once entered', async () => {
    const open = await seedGiveaway();
    const player = await seedPlayer();
    await db.insert(giveawayEntries).values({ giveawayId: open.id, playerProfileId: player.id, entryCount: 2, ticketsSpent: 20 });
    expect(await getMyEntry(db, open.id, player.id)).toEqual({ entryCount: 2, ticketsSpent: 20 });
  });

  it('listMyGiveawayEntries includes closed giveaways and flags the winner', async () => {
    const player = await seedPlayer();
    const other = await seedPlayer();
    const drawn = await seedGiveaway({ status: 'drawn', winnerPlayerProfileId: player.id });
    await db.insert(giveawayEntries).values({ giveawayId: drawn.id, playerProfileId: player.id, entryCount: 1, ticketsSpent: 10 });

    const lostOne = await seedGiveaway({ status: 'drawn', winnerPlayerProfileId: other.id });
    await db.insert(giveawayEntries).values({ giveawayId: lostOne.id, playerProfileId: player.id, entryCount: 1, ticketsSpent: 10 });

    const list = await listMyGiveawayEntries(db, player.id);
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.giveawayId === drawn.id)?.isWinner).toBe(true);
    expect(list.find((e) => e.giveawayId === lostOne.id)?.isWinner).toBe(false);
  });
});
