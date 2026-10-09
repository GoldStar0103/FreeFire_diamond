/**
 * Season funnel + Pass economics against real Postgres.
 *
 * Rows are inserted directly rather than driven through a full order
 * lifecycle: what is under test is the counting and the ratio arithmetic, and
 * `level-pass-store.test.ts` already proves the write path that produces
 * these rows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import {
  levelPassCheckpointEvents,
  levelPassLpTransactions,
  orders,
  playerProfiles,
  seasons,
  vaultEntitlements,
} from '../schema.js';
import { getSeasonFunnel, listSeasonFunnels } from './season-funnel-queries.js';
import { saveLevelPassCheckpoints } from './level-pass-settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_season_funnel_test';

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
    raw`TRUNCATE seasons, player_profiles, level_pass_lp_transactions,
        level_pass_checkpoint_events, vault_entitlements, orders, settings
        RESTART IDENTITY CASCADE`,
  );
  // A small, explicit ladder so the expected percentages are obvious.
  await saveLevelPassCheckpoints(db, [
    { lp: 60, rewardDiamonds: 110, costCents: 1_200, recipe: [] },
    { lp: 260, rewardDiamonds: 340, costCents: 4_000, recipe: [] },
  ]);
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

async function seedProfile(playerId: string) {
  const [profile] = await db
    .insert(playerProfiles)
    .values({ playerId, email: `${playerId}@test.levelup` })
    .returning();
  return profile!;
}

/** One LP-earning order for this player: what makes them a "participant". */
async function seedLpTransaction(
  seasonId: string,
  playerProfileId: string,
  opts: { profitCents: number; awardedLp: number },
) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `LU-${Math.random().toString(36).slice(2, 10)}`,
      playerId: '100000',
      comboKey: 'test_combo',
      comboSnapshot: { name: 'Test' },
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
  });
}

async function seedCheckpoint(
  seasonId: string,
  playerProfileId: string,
  checkpointLp: number,
  opts: { status?: 'pending' | 'granted'; costCents?: number } = {},
) {
  await db.insert(levelPassCheckpointEvents).values({
    seasonId,
    playerProfileId,
    checkpointLp,
    rewardDiamonds: 110,
    internalCostCents: opts.costCents ?? 1_200,
    status: opts.status ?? 'pending',
  });
}

describe.skipIf(!PG_AVAILABLE)('getSeasonFunnel', () => {
  it('returns null for a season that does not exist', async () => {
    expect(await getSeasonFunnel(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('reports an empty but well-formed funnel for a season nobody has played', async () => {
    const season = await seedSeason();
    const funnel = await getSeasonFunnel(db, season.id);

    expect(funnel).toMatchObject({
      participants: 0,
      vaultUnlocked: 0,
      totalLpAwarded: 0,
      profitFromParticipantsCents: 0,
      rewardCostCents: 0,
      retainedProfitCents: 0,
      realizedRewardCostRatioPct: null,
    });
    // Every configured stage still appears, at zero — a stage nobody reached
    // is a finding, not a row to hide.
    expect(funnel?.stages.map((s) => s.checkpointLp)).toEqual([60, 260]);
    expect(funnel?.stages.every((s) => s.reached === 0)).toBe(true);
    expect(funnel?.stages[0]?.pctOfParticipants).toBeNull();
  });

  it('counts a player once however many orders they placed', async () => {
    const season = await seedSeason();
    const profile = await seedProfile('100001');
    await seedLpTransaction(season.id, profile.id, { profitCents: 1_000, awardedLp: 10 });
    await seedLpTransaction(season.id, profile.id, { profitCents: 2_000, awardedLp: 20 });

    const funnel = await getSeasonFunnel(db, season.id);

    expect(funnel?.participants).toBe(1);
    expect(funnel?.totalLpAwarded).toBe(30);
    expect(funnel?.profitFromParticipantsCents).toBe(3_000);
  });

  it('computes drop-off between stages and against all participants', async () => {
    const season = await seedSeason();
    const a = await seedProfile('100001');
    const b = await seedProfile('100002');
    const c = await seedProfile('100003');
    const d = await seedProfile('100004');
    for (const p of [a, b, c, d]) {
      await seedLpTransaction(season.id, p.id, { profitCents: 1_000, awardedLp: 10 });
    }
    // 4 participants -> 2 reach 60 LP -> 1 reaches 260 LP.
    await seedCheckpoint(season.id, a.id, 60);
    await seedCheckpoint(season.id, b.id, 60);
    await seedCheckpoint(season.id, a.id, 260);

    const funnel = await getSeasonFunnel(db, season.id);

    expect(funnel?.participants).toBe(4);
    expect(funnel?.stages[0]).toMatchObject({ reached: 2, pctOfParticipants: 50, pctOfPrevious: null });
    expect(funnel?.stages[1]).toMatchObject({ reached: 1, pctOfParticipants: 25, pctOfPrevious: 50 });
  });

  it('counts Vault unlocks', async () => {
    const season = await seedSeason();
    const profile = await seedProfile('100001');
    await db.insert(vaultEntitlements).values({
      seasonId: season.id,
      playerProfileId: profile.id,
      expiresAt: new Date('2026-03-01'),
    });

    expect((await getSeasonFunnel(db, season.id))?.vaultUnlocked).toBe(1);
  });

  it('counts only granted rewards as cost — a reached checkpoint is a liability, not an expense', async () => {
    const season = await seedSeason();
    const profile = await seedProfile('100001');
    await seedLpTransaction(season.id, profile.id, { profitCents: 10_000, awardedLp: 100 });
    await seedCheckpoint(season.id, profile.id, 60, { status: 'granted', costCents: 1_200 });
    await seedCheckpoint(season.id, profile.id, 260, { status: 'pending', costCents: 4_000 });

    const funnel = await getSeasonFunnel(db, season.id);

    expect(funnel?.rewardCostCents).toBe(1_200); // not 5,200
    expect(funnel?.retainedProfitCents).toBe(10_000 - 1_200);
    // The design target is ~20%; this season is running at 12% because the
    // second reward has not been delivered yet. Reported as measured.
    expect(funnel?.realizedRewardCostRatioPct).toBeCloseTo(12, 5);
  });

  it('keeps each season separate', async () => {
    const one = await seedSeason(1);
    const two = await seedSeason(2);
    const a = await seedProfile('100001');
    const b = await seedProfile('100002');
    await seedLpTransaction(one.id, a.id, { profitCents: 1_000, awardedLp: 10 });
    await seedLpTransaction(two.id, b.id, { profitCents: 5_000, awardedLp: 50 });
    await seedCheckpoint(two.id, b.id, 60, { status: 'granted' });

    expect(await getSeasonFunnel(db, one.id)).toMatchObject({
      participants: 1,
      profitFromParticipantsCents: 1_000,
      rewardCostCents: 0,
    });
    expect(await getSeasonFunnel(db, two.id)).toMatchObject({
      participants: 1,
      profitFromParticipantsCents: 5_000,
      rewardCostCents: 1_200,
    });
  });
});

describe.skipIf(!PG_AVAILABLE)('listSeasonFunnels', () => {
  it('returns every season, newest first, for season-over-season comparison', async () => {
    await seedSeason(1);
    await seedSeason(2);
    await seedSeason(3);

    const all = await listSeasonFunnels(db);

    expect(all.map((f) => f.seasonNumber)).toEqual([3, 2, 1]);
  });

  it('is empty before any season has run', async () => {
    expect(await listSeasonFunnels(db)).toEqual([]);
  });
});
