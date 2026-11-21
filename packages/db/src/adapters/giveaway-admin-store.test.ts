/**
 * `DrizzleGiveawayAdminStore` against real Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { adminUsers, giveawayEntries, giveaways, notifications, playerProfiles, ticketTransactions } from '../schema.js';
import { DrizzleGiveawayAdminStore, type CreateGiveawayInput } from './giveaway-admin-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_giveaway_admin_store_test';

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
  await db.execute(raw`TRUNCATE giveaways, player_profiles, admin_users, notifications RESTART IDENTITY CASCADE`);
  const [admin] = await db
    .insert(adminUsers)
    .values({ email: `admin-${Math.random()}@test.com`, passwordHash: 'x' })
    .returning();
  adminId = admin!.id;
});

const store = () => new DrizzleGiveawayAdminStore(db);

async function seedPlayer(ticketBalance = 0) {
  const playerId = `p-${Math.random().toString(36).slice(2)}`;
  const [profile] = await db
    .insert(playerProfiles)
    .values({ playerId, email: `${playerId}@test.levelup`, ticketBalance })
    .returning();
  return profile!;
}

const baseInput: CreateGiveawayInput = {
  title: 'Sorteo de prueba',
  description: 'Descripción',
  prizeDescription: '1000 diamantes',
  entryCostTickets: 10,
  scheduleType: 'daily',
  minEntries: 2,
  opensAt: new Date('2026-11-01T00:00:00Z'),
  closesAt: new Date('2026-11-08T00:00:00Z'),
};

async function enterGiveaway(giveawayId: string, playerProfileId: string, entryCount: number, ticketsSpent: number) {
  await db.insert(giveawayEntries).values({ giveawayId, playerProfileId, entryCount, ticketsSpent });
}

describe.skipIf(!PG_AVAILABLE)('DrizzleGiveawayAdminStore create/update/publish', () => {
  it('creates a draft giveaway', async () => {
    const id = await store().create(baseInput, adminId);
    const row = await store().getForAdmin(id);
    expect(row).toMatchObject({ title: 'Sorteo de prueba', status: 'draft', totalEntryCount: 0, totalEntrants: 0 });
  });

  it('stores optional entry/participant caps, defaulting to no limit', async () => {
    const withoutCaps = await store().create(baseInput, adminId);
    const rowWithoutCaps = await store().getForAdmin(withoutCaps);
    expect(rowWithoutCaps).toMatchObject({ maxEntriesPerPlayer: null, maxParticipants: null });

    const withCaps = await store().create({ ...baseInput, maxEntriesPerPlayer: 5, maxParticipants: 100 }, adminId);
    const rowWithCaps = await store().getForAdmin(withCaps);
    expect(rowWithCaps).toMatchObject({ maxEntriesPerPlayer: 5, maxParticipants: 100 });
  });

  it('updates a draft giveaway but refuses once it is open', async () => {
    const id = await store().create(baseInput, adminId);
    expect(await store().update(id, { title: 'Nuevo título' }, adminId)).toBe(true);
    await store().publish(id, adminId);
    expect(await store().update(id, { title: 'Otro' }, adminId)).toBe(false);
  });

  it('publish moves draft -> open and refuses a second publish', async () => {
    const id = await store().create(baseInput, adminId);
    expect(await store().publish(id, adminId)).toBe(true);
    expect(await store().publish(id, adminId)).toBe(false);
    const row = await store().getForAdmin(id);
    expect(row?.status).toBe('open');
  });
});

describe.skipIf(!PG_AVAILABLE)('DrizzleGiveawayAdminStore.closeDueGiveaways', () => {
  it('moves a past-due giveaway that met its minimum to closed_pending_draw without touching tickets', async () => {
    const id = await store().create({ ...baseInput, closesAt: new Date('2026-01-01T00:00:00Z') }, adminId);
    await store().publish(id, adminId);
    const p1 = await seedPlayer(50);
    const p2 = await seedPlayer(50);
    await enterGiveaway(id, p1.id, 1, 10);
    await enterGiveaway(id, p2.id, 1, 10);

    const result = await store().closeDueGiveaways(new Date('2026-01-02T00:00:00Z'));
    expect(result).toEqual({ closedPendingDraw: 1, cancelledAndRefunded: 0 });

    const row = await store().getForAdmin(id);
    expect(row?.status).toBe('closed_pending_draw');
    const [profile] = await db.select().from(playerProfiles).where(eq(playerProfiles.id, p1.id));
    expect(profile?.ticketBalance).toBe(50);
  });

  it('cancels and refunds every entrant when the minimum was not met', async () => {
    const id = await store().create({ ...baseInput, closesAt: new Date('2026-01-01T00:00:00Z') }, adminId);
    await store().publish(id, adminId);
    const p1 = await seedPlayer(40);
    await enterGiveaway(id, p1.id, 1, 10);

    const result = await store().closeDueGiveaways(new Date('2026-01-02T00:00:00Z'));
    expect(result).toEqual({ closedPendingDraw: 0, cancelledAndRefunded: 1 });

    const row = await store().getForAdmin(id);
    expect(row?.status).toBe('cancelled');

    const [profile] = await db.select().from(playerProfiles).where(eq(playerProfiles.id, p1.id));
    expect(profile?.ticketBalance).toBe(50);

    const [ledgerRow] = await db
      .select()
      .from(ticketTransactions)
      .where(eq(ticketTransactions.playerProfileId, p1.id));
    expect(ledgerRow).toMatchObject({ type: 'return', amount: 10, resultingBalance: 50, giveawayId: id });

    const [notif] = await db.select().from(notifications).where(eq(notifications.playerProfileId, p1.id));
    expect(notif?.type).toBe('giveaway_cancelled');
  });

  it('leaves a still-open giveaway untouched', async () => {
    const id = await store().create(baseInput, adminId);
    await store().publish(id, adminId);
    const result = await store().closeDueGiveaways(new Date('2026-01-01T00:00:00Z'));
    expect(result).toEqual({ closedPendingDraw: 0, cancelledAndRefunded: 0 });
    const row = await store().getForAdmin(id);
    expect(row?.status).toBe('open');
  });
});

describe.skipIf(!PG_AVAILABLE)('DrizzleGiveawayAdminStore.drawWinner', () => {
  it('picks a winner from the entry pool and marks the giveaway drawn', async () => {
    const id = await store().create(baseInput, adminId);
    await store().publish(id, adminId);
    const p1 = await seedPlayer();
    await enterGiveaway(id, p1.id, 3, 30);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, id));

    const result = await store().drawWinner(id, adminId, () => 0.5);
    expect(result).toEqual({ ok: true, winnerPlayerProfileId: p1.id });

    const row = await store().getForAdmin(id);
    expect(row).toMatchObject({ status: 'drawn', winnerPlayerProfileId: p1.id });

    const [notif] = await db.select().from(notifications).where(eq(notifications.playerProfileId, p1.id));
    expect(notif?.type).toBe('giveaway_won');
  });

  it('refuses to draw a giveaway that is not closed_pending_draw', async () => {
    const id = await store().create(baseInput, adminId);
    const result = await store().drawWinner(id, adminId);
    expect(result).toEqual({ ok: false, reason: 'wrong_status' });
  });

  it('refuses to draw with no entries', async () => {
    const id = await store().create(baseInput, adminId);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, id));
    const result = await store().drawWinner(id, adminId);
    expect(result).toEqual({ ok: false, reason: 'no_entries' });
  });
});

describe.skipIf(!PG_AVAILABLE)('DrizzleGiveawayAdminStore.cancel / markDelivered', () => {
  it('cancel refunds every entrant and is a no-op once drawn', async () => {
    const id = await store().create(baseInput, adminId);
    await store().publish(id, adminId);
    const p1 = await seedPlayer(20);
    await enterGiveaway(id, p1.id, 1, 10);

    expect(await store().cancel(id, adminId, 'Prueba manual')).toBe(true);
    const [profile] = await db.select().from(playerProfiles).where(eq(playerProfiles.id, p1.id));
    expect(profile?.ticketBalance).toBe(30);

    const id2 = await store().create(baseInput, adminId);
    await store().publish(id2, adminId);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, id2));
    const p2 = await seedPlayer();
    await enterGiveaway(id2, p2.id, 1, 10);
    await store().drawWinner(id2, adminId);
    expect(await store().cancel(id2, adminId, 'tarde')).toBe(false);
  });

  it('markDelivered only succeeds from drawn', async () => {
    const id = await store().create(baseInput, adminId);
    await store().publish(id, adminId);
    expect(await store().markDelivered(id, adminId)).toBe(false);

    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, id));
    const p1 = await seedPlayer();
    await enterGiveaway(id, p1.id, 1, 10);
    await store().drawWinner(id, adminId);

    expect(await store().markDelivered(id, adminId)).toBe(true);
    const row = await store().getForAdmin(id);
    expect(row?.status).toBe('delivered');
  });
});

describe.skipIf(!PG_AVAILABLE)('DrizzleGiveawayAdminStore.listEntries', () => {
  it('lists entrants ordered by entryCount descending', async () => {
    const id = await store().create(baseInput, adminId);
    const p1 = await seedPlayer();
    const p2 = await seedPlayer();
    await enterGiveaway(id, p1.id, 1, 10);
    await enterGiveaway(id, p2.id, 5, 50);

    const entries = await store().listEntries(id);
    expect(entries.map((e) => e.playerProfileId)).toEqual([p2.id, p1.id]);
  });
});
