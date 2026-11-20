/**
 * `DrizzleGiveawayEntryStore` against real Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { adminUsers, giveaways, playerProfiles, ticketTransactions } from '../schema.js';
import { DrizzleGiveawayEntryStore } from './giveaway-entry-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_giveaway_entry_store_test';

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

const store = () => new DrizzleGiveawayEntryStore(db);

async function seedPlayer(ticketBalance = 0) {
  const playerId = `p-${Math.random().toString(36).slice(2)}`;
  const [profile] = await db
    .insert(playerProfiles)
    .values({ playerId, email: `${playerId}@test.levelup`, ticketBalance })
    .returning();
  return profile!;
}

async function seedOpenGiveaway(overrides: { entryCostTickets?: number } = {}) {
  const [row] = await db
    .insert(giveaways)
    .values({
      title: 'Sorteo',
      description: 'd',
      prizeDescription: 'p',
      entryCostTickets: overrides.entryCostTickets ?? 10,
      scheduleType: 'daily',
      minEntries: 0,
      opensAt: new Date('2026-11-01T00:00:00Z'),
      closesAt: new Date('2026-11-08T00:00:00Z'),
      status: 'open',
      createdByAdminId: adminId,
    })
    .returning();
  return row!;
}

describe.skipIf(!PG_AVAILABLE)('DrizzleGiveawayEntryStore.findGiveawayForEntry', () => {
  it('returns the giveaway window + entry cost', async () => {
    const giveaway = await seedOpenGiveaway();
    const found = await store().findGiveawayForEntry(giveaway.id);
    expect(found).toMatchObject({ id: giveaway.id, status: 'open', entryCostTickets: 10 });
  });

  it('returns null for an unknown id', async () => {
    expect(await store().findGiveawayForEntry('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe.skipIf(!PG_AVAILABLE)('DrizzleGiveawayEntryStore.spendTicketsForEntry', () => {
  it('debits the balance, upserts the entry row, and logs a ledger row', async () => {
    const giveaway = await seedOpenGiveaway();
    const player = await seedPlayer(100);

    const result = await store().spendTicketsForEntry({
      giveawayId: giveaway.id,
      playerProfileId: player.id,
      entryCount: 3,
      costTickets: 30,
    });

    expect(result).toEqual({ ok: true, resultingBalance: 70, totalEntryCount: 3, totalTicketsSpent: 30 });

    const [profile] = await db.select().from(playerProfiles).where(eq(playerProfiles.id, player.id));
    expect(profile?.ticketBalance).toBe(70);

    const [ledgerRow] = await db
      .select()
      .from(ticketTransactions)
      .where(eq(ticketTransactions.playerProfileId, player.id));
    expect(ledgerRow).toMatchObject({ type: 'entry', amount: -30, resultingBalance: 70, giveawayId: giveaway.id });
  });

  it('accumulates entryCount/ticketsSpent across repeated entries by the same player', async () => {
    const giveaway = await seedOpenGiveaway();
    const player = await seedPlayer(100);

    await store().spendTicketsForEntry({
      giveawayId: giveaway.id,
      playerProfileId: player.id,
      entryCount: 2,
      costTickets: 20,
    });
    const second = await store().spendTicketsForEntry({
      giveawayId: giveaway.id,
      playerProfileId: player.id,
      entryCount: 1,
      costTickets: 10,
    });

    expect(second).toEqual({ ok: true, resultingBalance: 70, totalEntryCount: 3, totalTicketsSpent: 30 });
  });

  it('refuses to spend more tickets than the player has and writes nothing', async () => {
    const giveaway = await seedOpenGiveaway();
    const player = await seedPlayer(5);

    const result = await store().spendTicketsForEntry({
      giveawayId: giveaway.id,
      playerProfileId: player.id,
      entryCount: 1,
      costTickets: 10,
    });

    expect(result).toEqual({ ok: false, currentBalance: 5 });
    const [profile] = await db.select().from(playerProfiles).where(eq(playerProfiles.id, player.id));
    expect(profile?.ticketBalance).toBe(5);
    const ledgerRows = await db.select().from(ticketTransactions).where(eq(ticketTransactions.playerProfileId, player.id));
    expect(ledgerRows).toHaveLength(0);
  });
});
