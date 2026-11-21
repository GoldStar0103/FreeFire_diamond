/**
 * Storefront/account read models (`giveaway-queries.ts`) against real Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { adminUsers, giveawayEntries, giveaways, giveawayWinners, playerProfiles } from '../schema.js';
import {
  getGiveawayPublic,
  getMyEntry,
  getOpenGiveaway,
  listGiveawayLeaderboard,
  listMyGiveawayEntries,
  listOpenGiveaways,
  listRecentCompletedGiveaways,
} from './giveaway-queries.js';

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
  await db.execute(raw`TRUNCATE giveaways, giveaway_winners, player_profiles, admin_users RESTART IDENTITY CASCADE`);
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

async function seedWinner(giveawayId: string, playerProfileId: string, position = 1) {
  await db.insert(giveawayWinners).values({
    giveawayId,
    playerProfileId,
    freeFireId: '123456789',
    position,
    costCentsSnapshot: 1000,
  });
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
    expect(await getMyEntry(db, open.id, player.id)).toEqual({
      entryCount: 2,
      ticketsSpent: 20,
      freeFireId: null,
      freeFireNickname: null,
    });
  });

  it('listMyGiveawayEntries includes closed giveaways and flags the winner', async () => {
    const player = await seedPlayer();
    const other = await seedPlayer();
    const drawn = await seedGiveaway({ status: 'drawn' });
    await db.insert(giveawayEntries).values({ giveawayId: drawn.id, playerProfileId: player.id, entryCount: 1, ticketsSpent: 10 });
    await seedWinner(drawn.id, player.id);

    const lostOne = await seedGiveaway({ status: 'drawn' });
    await db.insert(giveawayEntries).values({ giveawayId: lostOne.id, playerProfileId: player.id, entryCount: 1, ticketsSpent: 10 });
    await seedWinner(lostOne.id, other.id);

    const list = await listMyGiveawayEntries(db, player.id);
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.giveawayId === drawn.id)?.isWinner).toBe(true);
    expect(list.find((e) => e.giveawayId === lostOne.id)?.isWinner).toBe(false);
  });
});

describe.skipIf(!PG_AVAILABLE)('getGiveawayPublic', () => {
  it('returns null for a draft (admin-only) giveaway', async () => {
    const draft = await seedGiveaway({ status: 'draft' });
    expect(await getGiveawayPublic(db, draft.id)).toBeNull();
  });

  it('returns an open giveaway with no winner yet', async () => {
    const open = await seedGiveaway();
    const found = await getGiveawayPublic(db, open.id);
    expect(found).toMatchObject({ id: open.id, status: 'open', winnerDisplayNames: [], totalEntryCount: 0 });
  });

  it('includes every winner display name once drawn', async () => {
    const winner = await seedPlayer();
    await db.update(playerProfiles).set({ displayName: 'Ganador123' }).where(eq(playerProfiles.id, winner.id));
    const second = await seedPlayer();
    await db.update(playerProfiles).set({ displayName: 'Ganador456' }).where(eq(playerProfiles.id, second.id));
    const drawn = await seedGiveaway({ status: 'drawn' });
    await seedWinner(drawn.id, winner.id, 1);
    await seedWinner(drawn.id, second.id, 2);

    const found = await getGiveawayPublic(db, drawn.id);
    expect(found).toMatchObject({ status: 'drawn', winnerDisplayNames: ['Ganador123', 'Ganador456'] });
  });

  it('surfaces the cancel reason for a cancelled giveaway', async () => {
    const cancelled = await seedGiveaway({ status: 'cancelled', cancelReason: 'No alcanzó el mínimo' });
    const found = await getGiveawayPublic(db, cancelled.id);
    expect(found).toMatchObject({ status: 'cancelled', cancelReason: 'No alcanzó el mínimo' });
  });
});

describe.skipIf(!PG_AVAILABLE)('listGiveawayLeaderboard', () => {
  it('orders entrants by entryCount descending, never exposing ticketsSpent', async () => {
    const giveaway = await seedGiveaway();
    const leader = await seedPlayer();
    const trailing = await seedPlayer();
    await db.insert(giveawayEntries).values({ giveawayId: giveaway.id, playerProfileId: leader.id, entryCount: 5, ticketsSpent: 50 });
    await db.insert(giveawayEntries).values({ giveawayId: giveaway.id, playerProfileId: trailing.id, entryCount: 1, ticketsSpent: 10 });

    const board = await listGiveawayLeaderboard(db, giveaway.id);
    expect(board.map((r) => r.playerProfileId)).toEqual([leader.id, trailing.id]);
    expect(board[0]).not.toHaveProperty('ticketsSpent');
  });

  it('falls back to a generic label when the player has no display name', async () => {
    const giveaway = await seedGiveaway();
    const player = await seedPlayer();
    await db.insert(giveawayEntries).values({ giveawayId: giveaway.id, playerProfileId: player.id, entryCount: 1, ticketsSpent: 10 });

    const board = await listGiveawayLeaderboard(db, giveaway.id);
    expect(board[0]?.displayName).toBe(`Jugador ${player.playerId}`);
  });
});

describe.skipIf(!PG_AVAILABLE)('listRecentCompletedGiveaways', () => {
  it('lists drawn/delivered/cancelled giveaways, newest-closed first, excluding open/draft ones', async () => {
    await seedGiveaway({ status: 'open' });
    await seedGiveaway({ status: 'draft' });
    const older = await seedGiveaway({ status: 'delivered', closesAt: new Date('2026-10-01T00:00:00Z') });
    const newer = await seedGiveaway({ status: 'cancelled', closesAt: new Date('2026-11-01T00:00:00Z') });

    const list = await listRecentCompletedGiveaways(db);
    expect(list.map((g) => g.id)).toEqual([newer.id, older.id]);
  });

  it('includes the winner display name and total entries', async () => {
    const winner = await seedPlayer();
    const drawn = await seedGiveaway({ status: 'drawn' });
    await db.insert(giveawayEntries).values({ giveawayId: drawn.id, playerProfileId: winner.id, entryCount: 3, ticketsSpent: 30 });
    await seedWinner(drawn.id, winner.id);

    const [row] = await listRecentCompletedGiveaways(db);
    expect(row).toMatchObject({ id: drawn.id, winnerDisplayNames: [`Jugador ${winner.playerId}`], totalEntryCount: 3 });
  });
});
