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
import {
  adminUsers,
  financialLedgerEntries,
  giveawayEntries,
  giveaways,
  giveawayWinners,
  notifications,
  orders,
  playerProfiles,
  ticketTransactions,
} from '../schema.js';
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
  await db.execute(
    raw`TRUNCATE giveaways, giveaway_winners, orders, order_items, player_profiles, admin_users, notifications RESTART IDENTITY CASCADE`,
  );
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
  winnerCount: 1,
  prizeType: 'manual',
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
  it('moves a past-due giveaway that met its minimum to closed_pending_draw without touching tickets, when no prize value is set yet', async () => {
    const id = await store().create({ ...baseInput, closesAt: new Date('2026-01-01T00:00:00Z') }, adminId);
    await store().publish(id, adminId);
    const p1 = await seedPlayer(50);
    const p2 = await seedPlayer(50);
    await enterGiveaway(id, p1.id, 1, 10);
    await enterGiveaway(id, p2.id, 1, 10);

    const result = await store().closeDueGiveaways(new Date('2026-01-02T00:00:00Z'));
    expect(result).toEqual({ closedPendingDraw: 1, autoDrawn: 0, cancelledAndRefunded: 0 });

    const row = await store().getForAdmin(id);
    expect(row?.status).toBe('closed_pending_draw');
    const [profile] = await db.select().from(playerProfiles).where(eq(playerProfiles.id, p1.id));
    expect(profile?.ticketBalance).toBe(50);
  });

  it('draws the winner automatically when the minimum is met and a prize value is already set', async () => {
    const id = await store().create({ ...baseInput, closesAt: new Date('2026-01-01T00:00:00Z') }, adminId);
    await store().setPrizeValueCents(id, 75000, adminId);
    await store().publish(id, adminId);
    const p1 = await seedPlayer();
    const p2 = await seedPlayer();
    await enterGiveaway(id, p1.id, 1, 10);
    await enterGiveaway(id, p2.id, 1, 10);

    const result = await store().closeDueGiveaways(new Date('2026-01-02T00:00:00Z'), () => 0.9);
    expect(result).toEqual({ closedPendingDraw: 0, autoDrawn: 1, cancelledAndRefunded: 0 });

    const row = await store().getForAdmin(id);
    expect(row?.status).toBe('drawn');

    const winners = await store().listWinners(id);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ playerProfileId: p2.id, costCentsSnapshot: 75000, deliveryStatus: 'pending' });

    const [notif] = await db.select().from(notifications).where(eq(notifications.playerProfileId, p2.id));
    expect(notif?.type).toBe('giveaway_won');
  });

  it('cancels and refunds every entrant when the minimum was not met', async () => {
    const id = await store().create({ ...baseInput, closesAt: new Date('2026-01-01T00:00:00Z') }, adminId);
    await store().publish(id, adminId);
    const p1 = await seedPlayer(40);
    await enterGiveaway(id, p1.id, 1, 10);

    const result = await store().closeDueGiveaways(new Date('2026-01-02T00:00:00Z'));
    expect(result).toEqual({ closedPendingDraw: 0, autoDrawn: 0, cancelledAndRefunded: 1 });

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
    expect(result).toEqual({ closedPendingDraw: 0, autoDrawn: 0, cancelledAndRefunded: 0 });
    const row = await store().getForAdmin(id);
    expect(row?.status).toBe('open');
  });
});

describe.skipIf(!PG_AVAILABLE)('DrizzleGiveawayAdminStore.drawWinners', () => {
  it('refuses to draw without a prize value set', async () => {
    const id = await store().create(baseInput, adminId);
    await store().publish(id, adminId);
    const p1 = await seedPlayer();
    await enterGiveaway(id, p1.id, 3, 30);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, id));

    const result = await store().drawWinners(id, adminId, () => 0.5);
    expect(result).toEqual({ ok: false, reason: 'prize_value_required' });
  });

  it('picks one winner from the entry pool and marks the giveaway drawn', async () => {
    const id = await store().create(baseInput, adminId);
    await store().setPrizeValueCents(id, 75000, adminId);
    await store().publish(id, adminId);
    const p1 = await seedPlayer();
    await enterGiveaway(id, p1.id, 3, 30);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, id));

    const result = await store().drawWinners(id, adminId, () => 0.5);
    expect(result).toEqual({ ok: true, winnerCount: 1 });

    const row = await store().getForAdmin(id);
    expect(row?.status).toBe('drawn');

    const winners = await store().listWinners(id);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      playerProfileId: p1.id,
      position: 1,
      costCentsSnapshot: 75000,
      deliveryStatus: 'pending',
      // No freeFireId captured at entry in this harness — falls back to the profile's linked ID.
      freeFireId: p1.playerId,
    });

    const [notif] = await db.select().from(notifications).where(eq(notifications.playerProfileId, p1.id));
    expect(notif?.type).toBe('giveaway_won');
  });

  it('draws several distinct winners when winnerCount > 1', async () => {
    const id = await store().create({ ...baseInput, winnerCount: 2 }, adminId);
    await store().setPrizeValueCents(id, 10000, adminId);
    await store().publish(id, adminId);
    const p1 = await seedPlayer();
    const p2 = await seedPlayer();
    const p3 = await seedPlayer();
    await enterGiveaway(id, p1.id, 1, 10);
    await enterGiveaway(id, p2.id, 1, 10);
    await enterGiveaway(id, p3.id, 1, 10);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, id));

    const result = await store().drawWinners(id, adminId);
    expect(result).toEqual({ ok: true, winnerCount: 2 });

    const winners = await store().listWinners(id);
    expect(winners).toHaveLength(2);
    expect(new Set(winners.map((w) => w.playerProfileId)).size).toBe(2);
    expect(winners.map((w) => w.position)).toEqual([1, 2]);
  });

  it('refuses to draw a giveaway that is not closed_pending_draw', async () => {
    const id = await store().create(baseInput, adminId);
    await store().setPrizeValueCents(id, 1000, adminId);
    const result = await store().drawWinners(id, adminId);
    expect(result).toEqual({ ok: false, reason: 'wrong_status' });
  });

  it('refuses to draw with no entries', async () => {
    const id = await store().create(baseInput, adminId);
    await store().setPrizeValueCents(id, 1000, adminId);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, id));
    const result = await store().drawWinners(id, adminId);
    expect(result).toEqual({ ok: false, reason: 'no_entries' });
  });
});

describe.skipIf(!PG_AVAILABLE)('DrizzleGiveawayAdminStore.cancel / markWinnerDelivered', () => {
  it('cancel refunds every entrant and is a no-op once drawn', async () => {
    const id = await store().create(baseInput, adminId);
    await store().publish(id, adminId);
    const p1 = await seedPlayer(20);
    await enterGiveaway(id, p1.id, 1, 10);

    expect(await store().cancel(id, adminId, 'Prueba manual')).toBe(true);
    const [profile] = await db.select().from(playerProfiles).where(eq(playerProfiles.id, p1.id));
    expect(profile?.ticketBalance).toBe(30);

    const id2 = await store().create(baseInput, adminId);
    await store().setPrizeValueCents(id2, 1000, adminId);
    await store().publish(id2, adminId);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, id2));
    const p2 = await seedPlayer();
    await enterGiveaway(id2, p2.id, 1, 10);
    await store().drawWinners(id2, adminId);
    expect(await store().cancel(id2, adminId, 'tarde')).toBe(false);
  });

  it('markWinnerDelivered posts the ledger expense and finalizes the giveaway once every winner is delivered', async () => {
    const id = await store().create(baseInput, adminId);
    await store().setPrizeValueCents(id, 75000, adminId);
    await store().publish(id, adminId);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, id));
    const p1 = await seedPlayer();
    await enterGiveaway(id, p1.id, 1, 10);
    await store().drawWinners(id, adminId);

    const [winner] = await store().listWinners(id);
    expect(await store().markWinnerDelivered(id, winner!.id, adminId)).toEqual({ ok: true });

    const row = await store().getForAdmin(id);
    expect(row?.status).toBe('delivered');

    const [ledgerRow] = await db
      .select()
      .from(financialLedgerEntries)
      .where(eq(financialLedgerEntries.sourceId, id));
    expect(ledgerRow).toMatchObject({
      entryType: 'giveaway_prize',
      amountCents: -75000,
      sourceType: 'giveaway',
      createdByAdminId: adminId,
    });

    expect(await store().markWinnerDelivered(id, winner!.id, adminId)).toEqual({
      ok: false,
      reason: 'already_delivered',
    });
  });

  it('with two winners, the giveaway only finalizes once both are delivered', async () => {
    const id = await store().create({ ...baseInput, winnerCount: 2 }, adminId);
    await store().setPrizeValueCents(id, 5000, adminId);
    await store().publish(id, adminId);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, id));
    const p1 = await seedPlayer();
    const p2 = await seedPlayer();
    await enterGiveaway(id, p1.id, 1, 10);
    await enterGiveaway(id, p2.id, 1, 10);
    await store().drawWinners(id, adminId);

    const [w1, w2] = await store().listWinners(id);
    await store().markWinnerDelivered(id, w1!.id, adminId);
    expect((await store().getForAdmin(id))?.status).toBe('drawn');

    await store().markWinnerDelivered(id, w2!.id, adminId);
    expect((await store().getForAdmin(id))?.status).toBe('delivered');
  });

  it('setPrizeValueCents can edit the value any time before delivery, but not after', async () => {
    const id = await store().create(baseInput, adminId);
    expect(await store().setPrizeValueCents(id, 50000, adminId)).toBe(true);
    expect((await store().getForAdmin(id))?.prizeValueCents).toBe(50000);
    expect(await store().setPrizeValueCents(id, 60000, adminId)).toBe(true);
    expect((await store().getForAdmin(id))?.prizeValueCents).toBe(60000);

    await store().publish(id, adminId);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, id));
    const p1 = await seedPlayer();
    await enterGiveaway(id, p1.id, 1, 10);
    await store().drawWinners(id, adminId);
    const [winner] = await store().listWinners(id);
    await store().markWinnerDelivered(id, winner!.id, adminId);

    expect(await store().setPrizeValueCents(id, 70000, adminId)).toBe(false);
  });
});

describe.skipIf(!PG_AVAILABLE)('DrizzleGiveawayAdminStore.autoPublishDue', () => {
  it('publishes a draft whose opensAt has arrived, leaves others untouched', async () => {
    const due = await store().create(
      { ...baseInput, opensAt: new Date('2026-01-01T00:00:00Z'), closesAt: new Date('2026-01-08T00:00:00Z') },
      adminId,
    );
    const notYet = await store().create(
      { ...baseInput, opensAt: new Date('2026-02-01T00:00:00Z'), closesAt: new Date('2026-02-08T00:00:00Z') },
      adminId,
    );
    const alreadyClosed = await store().create(
      { ...baseInput, opensAt: new Date('2025-01-01T00:00:00Z'), closesAt: new Date('2025-01-08T00:00:00Z') },
      adminId,
    );

    const count = await store().autoPublishDue(new Date('2026-01-02T00:00:00Z'));
    expect(count).toBe(1);

    expect((await store().getForAdmin(due))?.status).toBe('open');
    expect((await store().getForAdmin(notYet))?.status).toBe('draft');
    expect((await store().getForAdmin(alreadyClosed))?.status).toBe('draft');
  });
});

describe.skipIf(!PG_AVAILABLE)('DrizzleGiveawayAdminStore automatic diamond-prize delivery', () => {
  it('findPendingGiveawayWinners only returns diamonds-type winners with no delivery order yet', async () => {
    const manualId = await store().create(baseInput, adminId);
    await store().setPrizeValueCents(manualId, 1000, adminId);
    await store().publish(manualId, adminId);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, manualId));
    const p1 = await seedPlayer();
    await enterGiveaway(manualId, p1.id, 1, 10);
    await store().drawWinners(manualId, adminId);

    const diamondsId = await store().create(
      { ...baseInput, prizeType: 'diamonds', prizeDiamonds: 100, prizeRecipe: [{ baseProductId: 'bp-1', diamondsBase: 100 }] },
      adminId,
    );
    await store().setPrizeValueCents(diamondsId, 1000, adminId);
    await store().publish(diamondsId, adminId);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, diamondsId));
    const p2 = await seedPlayer();
    await enterGiveaway(diamondsId, p2.id, 1, 10);
    await store().drawWinners(diamondsId, adminId);

    const pending = await store().findPendingGiveawayWinners(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ giveawayId: diamondsId, prizeDiamonds: 100 });
  });

  it('grantGiveawayPrize posts the ledger expense and finalizes the giveaway once the order completes', async () => {
    const id = await store().create(
      { ...baseInput, prizeType: 'diamonds', prizeDiamonds: 100, prizeRecipe: [{ baseProductId: 'bp-1', diamondsBase: 100 }] },
      adminId,
    );
    await store().setPrizeValueCents(id, 1200, adminId);
    await store().publish(id, adminId);
    await db.update(giveaways).set({ status: 'closed_pending_draw' }).where(eq(giveaways.id, id));
    const p1 = await seedPlayer();
    await enterGiveaway(id, p1.id, 1, 10);
    await store().drawWinners(id, adminId);
    const [winner] = await store().listWinners(id);

    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: `LU-TEST-${Math.random().toString(36).slice(2)}`,
        playerId: winner!.freeFireId,
        comboId: null,
        comboKey: 'giveaway_prize',
        comboSnapshot: {},
        priceMxnCents: 0,
        status: 'completed',
      })
      .returning({ id: orders.id });
    await db.update(giveawayWinners).set({ deliveryOrderId: order!.id }).where(eq(giveawayWinners.id, winner!.id));

    const completed = await store().findCompletedGiveawayPrizeOrders(10);
    expect(completed).toHaveLength(1);
    await store().grantGiveawayPrize(completed[0]!);

    const [delivered] = await store().listWinners(id);
    expect(delivered?.deliveryStatus).toBe('delivered');
    expect((await store().getForAdmin(id))?.status).toBe('delivered');

    const [ledgerRow] = await db
      .select()
      .from(financialLedgerEntries)
      .where(eq(financialLedgerEntries.sourceId, id));
    expect(ledgerRow).toMatchObject({ entryType: 'giveaway_prize', amountCents: -1200, sourceType: 'giveaway' });

    // Idempotent — a second grant for the same already-delivered winner posts nothing more.
    await store().grantGiveawayPrize(completed[0]!);
    const ledgerRows = await db
      .select()
      .from(financialLedgerEntries)
      .where(eq(financialLedgerEntries.sourceId, id));
    expect(ledgerRows).toHaveLength(1);
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
