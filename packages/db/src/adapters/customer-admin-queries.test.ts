/** The admin-side customer list and detail view, against real Postgres. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import {
  levelPassCheckpointEvents,
  levelPassLpTransactions,
  orders,
  playerProfiles,
  seasonPlayerStats,
  seasons,
  vaultEntitlements,
} from '../schema.js';
import { getAdminCustomerDetail, listAdminCustomers } from './customer-admin-queries.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_customer_admin_test';

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
    raw`TRUNCATE seasons, player_profiles, season_player_stats, level_pass_lp_transactions,
        level_pass_checkpoint_events, vault_entitlements, badge_ownerships, badge_definitions,
        orders, order_items RESTART IDENTITY CASCADE`,
  );
});

async function seedSeason(seasonNumber = 1) {
  const [season] = await db
    .insert(seasons)
    .values({
      seasonNumber,
      startsAt: new Date('2026-01-01'),
      endsAt: new Date('2026-03-01'),
      status: 'active',
    })
    .returning();
  return season!;
}

async function seedPlayer(
  playerId: string,
  opts: { displayName?: string; seasonId?: string; lp?: number; diamonds?: number } = {},
) {
  const [profile] = await db
    .insert(playerProfiles)
    .values({
      playerId,
      email: `${playerId}@test.levelup`,
      displayName: opts.displayName ?? null,
      lifetimeDiamondsPurchased: opts.diamonds ?? 0,
      lifetimeRechargeCount: opts.diamonds ? 1 : 0,
    })
    .returning();

  if (opts.seasonId) {
    await db.insert(seasonPlayerStats).values({
      seasonId: opts.seasonId,
      playerProfileId: profile!.id,
      lp: opts.lp ?? 0,
      seasonalDiamonds: opts.diamonds ?? 0,
    });
  }
  return profile!;
}

async function seedOrderWithLp(
  seasonId: string,
  playerProfileId: string,
  playerId: string,
  opts: { awardedLp: number; profitCents: number; reversed?: boolean },
) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `LU-${Math.random().toString(36).slice(2, 10)}`,
      playerId,
      playerProfileId,
      comboKey: 'test_combo',
      comboSnapshot: { name: 'Pack Test' },
      priceMxnCents: 10_000,
      status: 'completed',
      completedAt: new Date('2026-02-01'),
    })
    .returning();

  await db.insert(levelPassLpTransactions).values({
    orderId: order!.id,
    seasonId,
    playerProfileId,
    saleAmountCents: 10_000,
    productCostCents: 2_000,
    paymentFeeCents: 0,
    estimatedProfitCents: opts.profitCents,
    calculatedLp: opts.awardedLp,
    awardedLp: opts.awardedLp,
    reversedAt: opts.reversed ? new Date('2026-02-05') : null,
  });
  return order!;
}

describe.skipIf(!PG_AVAILABLE)('listAdminCustomers', () => {
  it('is empty before anyone signs up', async () => {
    expect(await listAdminCustomers(db)).toEqual([]);
  });

  it('lists players with their season standing, highest diamonds first', async () => {
    const season = await seedSeason();
    await seedPlayer('100001', { displayName: 'Ana', seasonId: season.id, lp: 60, diamonds: 500 });
    await seedPlayer('100002', { displayName: 'Beto', seasonId: season.id, lp: 300, diamonds: 2_000 });

    const rows = await listAdminCustomers(db);

    expect(rows.map((r) => r.displayName)).toEqual(['Beto', 'Ana']);
    expect(rows[0]).toMatchObject({ lp: 300, seasonalDiamonds: 2_000, rank: 1 });
    expect(rows[1]).toMatchObject({ lp: 60, seasonalDiamonds: 500, rank: 2 });
  });

  it('includes a player who has not bought anything this season, at zero', async () => {
    const season = await seedSeason();
    await seedPlayer('100001', { displayName: 'Ana' }); // no season_player_stats row

    const rows = await listAdminCustomers(db, { seasonId: season.id });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lp: 0, seasonalDiamonds: 0, rank: null, vaultActive: false });
  });

  it('searches by display name, linked ID or email', async () => {
    const season = await seedSeason();
    await seedPlayer('100001', { displayName: 'Ana', seasonId: season.id });
    await seedPlayer('209999', { displayName: 'Beto', seasonId: season.id });

    expect((await listAdminCustomers(db, { search: 'ana' }))[0]?.displayName).toBe('Ana');
    expect((await listAdminCustomers(db, { search: '2099' }))[0]?.displayName).toBe('Beto');
    expect((await listAdminCustomers(db, { search: '100001@' }))[0]?.displayName).toBe('Ana');
    expect(await listAdminCustomers(db, { search: 'nobody' })).toEqual([]);
  });

  it('drills down to the players who reached one checkpoint', async () => {
    const season = await seedSeason();
    const ana = await seedPlayer('100001', { displayName: 'Ana', seasonId: season.id, lp: 300 });
    await seedPlayer('100002', { displayName: 'Beto', seasonId: season.id, lp: 10 });

    await db.insert(levelPassCheckpointEvents).values({
      seasonId: season.id,
      playerProfileId: ana.id,
      checkpointLp: 60,
      rewardDiamonds: 110,
      internalCostCents: 1_200,
      status: 'pending',
    });

    const reached = await listAdminCustomers(db, { seasonId: season.id, checkpointLp: 60 });
    expect(reached.map((r) => r.displayName)).toEqual(['Ana']);

    // Nobody got this far.
    expect(await listAdminCustomers(db, { seasonId: season.id, checkpointLp: 1_185 })).toEqual([]);
  });

  it('flags an active Vault', async () => {
    const season = await seedSeason();
    const ana = await seedPlayer('100001', { seasonId: season.id });
    await db.insert(vaultEntitlements).values({
      seasonId: season.id,
      playerProfileId: ana.id,
      expiresAt: new Date('2026-03-01'),
    });

    expect((await listAdminCustomers(db))[0]?.vaultActive).toBe(true);
  });

  it('does not count an expired Vault as active', async () => {
    const season = await seedSeason();
    const ana = await seedPlayer('100001', { seasonId: season.id });
    await db.insert(vaultEntitlements).values({
      seasonId: season.id,
      playerProfileId: ana.id,
      status: 'expired',
      expiresAt: new Date('2026-03-01'),
    });

    expect((await listAdminCustomers(db))[0]?.vaultActive).toBe(false);
  });
});

describe.skipIf(!PG_AVAILABLE)('getAdminCustomerDetail', () => {
  it('returns null for an unknown profile', async () => {
    expect(await getAdminCustomerDetail(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('works before any season exists', async () => {
    const ana = await seedPlayer('100001', { displayName: 'Ana' });

    const detail = await getAdminCustomerDetail(db, ana.id);

    expect(detail).toMatchObject({ displayName: 'Ana', season: null });
    expect(detail?.economics.profitGeneratedCents).toBe(0);
  });

  it('reports the season economics the customer must never see', async () => {
    const season = await seedSeason();
    const ana = await seedPlayer('100001', { seasonId: season.id, lp: 100, diamonds: 500 });
    await seedOrderWithLp(season.id, ana.id, '100001', { awardedLp: 60, profitCents: 6_000 });
    await seedOrderWithLp(season.id, ana.id, '100001', { awardedLp: 40, profitCents: 4_000 });
    await db.insert(levelPassCheckpointEvents).values({
      seasonId: season.id,
      playerProfileId: ana.id,
      checkpointLp: 60,
      rewardDiamonds: 110,
      internalCostCents: 1_200,
      status: 'granted',
      grantedAt: new Date('2026-02-03'),
    });

    const detail = await getAdminCustomerDetail(db, ana.id);

    expect(detail?.economics).toEqual({
      profitGeneratedCents: 10_000,
      rewardCostCents: 1_200,
      retainedProfitCents: 8_800,
      lpAwarded: 100,
    });
  });

  it('stops counting a reversed order toward what the customer earned', async () => {
    const season = await seedSeason();
    const ana = await seedPlayer('100001', { seasonId: season.id });
    await seedOrderWithLp(season.id, ana.id, '100001', { awardedLp: 60, profitCents: 6_000 });
    await seedOrderWithLp(season.id, ana.id, '100001', {
      awardedLp: 40,
      profitCents: 4_000,
      reversed: true,
    });

    const detail = await getAdminCustomerDetail(db, ana.id);

    expect(detail?.economics.profitGeneratedCents).toBe(6_000);
    expect(detail?.economics.lpAwarded).toBe(60);
  });

  it('counts only granted rewards as cost, like the season funnel does', async () => {
    const season = await seedSeason();
    const ana = await seedPlayer('100001', { seasonId: season.id });
    await db.insert(levelPassCheckpointEvents).values([
      { seasonId: season.id, playerProfileId: ana.id, checkpointLp: 60, rewardDiamonds: 110, internalCostCents: 1_200, status: 'granted', grantedAt: new Date() },
      { seasonId: season.id, playerProfileId: ana.id, checkpointLp: 260, rewardDiamonds: 340, internalCostCents: 4_000, status: 'pending' },
      { seasonId: season.id, playerProfileId: ana.id, checkpointLp: 585, rewardDiamonds: 570, internalCostCents: 6_500, status: 'reversed' },
    ]);

    const detail = await getAdminCustomerDetail(db, ana.id);

    expect(detail?.economics.rewardCostCents).toBe(1_200);
    expect(detail?.season?.checkpoints).toHaveLength(3);
    expect(detail?.season?.checkpoints.map((c) => c.status)).toEqual(['granted', 'pending', 'reversed']);
  });

  it('lists the orders with their per-order LP and marks a reversed one', async () => {
    const season = await seedSeason();
    const ana = await seedPlayer('100001', { seasonId: season.id });
    await seedOrderWithLp(season.id, ana.id, '100001', { awardedLp: 60, profitCents: 6_000 });
    await seedOrderWithLp(season.id, ana.id, '100001', {
      awardedLp: 40,
      profitCents: 4_000,
      reversed: true,
    });

    const detail = await getAdminCustomerDetail(db, ana.id);

    expect(detail?.orders).toHaveLength(2);
    expect(detail?.orders.some((o) => o.lpReversedAt !== null)).toBe(true);
    expect(detail?.orders.every((o) => o.awardedLp !== null)).toBe(true);
  });

  it('includes a guest order placed to the same Free Fire ID before signing up', async () => {
    const season = await seedSeason();
    const ana = await seedPlayer('100001', { seasonId: season.id });
    // No playerProfileId — bought before the account existed.
    await db.insert(orders).values({
      orderNumber: 'LU-GUEST-1',
      playerId: '100001',
      comboKey: 'test_combo',
      comboSnapshot: { name: 'Pack Invitado' },
      priceMxnCents: 5_000,
      status: 'completed',
      completedAt: new Date('2026-01-15'),
    });

    const detail = await getAdminCustomerDetail(db, ana.id);

    expect(detail?.orders.map((o) => o.orderNumber)).toContain('LU-GUEST-1');
  });

  it('reports the Vault and the ranking position', async () => {
    const season = await seedSeason();
    const ana = await seedPlayer('100001', { seasonId: season.id, diamonds: 2_000 });
    await seedPlayer('100002', { seasonId: season.id, diamonds: 100 });
    await db.insert(vaultEntitlements).values({
      seasonId: season.id,
      playerProfileId: ana.id,
      expiresAt: new Date('2026-03-01'),
    });

    const detail = await getAdminCustomerDetail(db, ana.id);

    expect(detail?.season?.rank).toBe(1);
    expect(detail?.season?.vault.active).toBe(true);
    expect(detail?.season?.vault.expiresAt).not.toBeNull();
  });

  it('can be asked for a past season instead of the current one', async () => {
    const one = await seedSeason(1);
    const two = await seedSeason(2);
    const ana = await seedPlayer('100001', { seasonId: two.id, lp: 10 });
    await db.insert(seasonPlayerStats).values({
      seasonId: one.id,
      playerProfileId: ana.id,
      lp: 999,
      seasonalDiamonds: 5_000,
    });

    const current = await getAdminCustomerDetail(db, ana.id);
    const past = await getAdminCustomerDetail(db, ana.id, one.id);

    expect(current?.season?.seasonNumber).toBe(2);
    expect(current?.season?.lp).toBe(10);
    expect(past?.season?.seasonNumber).toBe(1);
    expect(past?.season?.lp).toBe(999);
  });
});
