/** Admin season queries against real Postgres. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { adminUsers, auditLog, hallOfFameEntries, playerProfiles, seasons } from '../schema.js';
import { getCurrentSeason, getSeasonRanges, hasAnySeason, listSeasonHistory, startFirstSeason } from './season-admin-queries.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_season_admin_test';

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
  await db.execute(raw`TRUNCATE seasons, hall_of_fame_entries, player_profiles, audit_log, admin_users RESTART IDENTITY CASCADE`);
});

async function seedAdmin(): Promise<string> {
  const [admin] = await db.insert(adminUsers).values({ email: `admin-${Date.now()}-${Math.random()}@test.com`, passwordHash: 'x' }).returning();
  return admin!.id;
}

describe.skipIf(!PG_AVAILABLE)('getSeasonRanges', () => {
  const NOW = new Date('2026-10-09T12:00:00Z');

  async function seedSeason(seasonNumber: number, startsAt: string, endsAt: string, status: 'active' | 'closed') {
    await db.insert(seasons).values({
      seasonNumber,
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      status,
      closedAt: status === 'closed' ? new Date(endsAt) : null,
    });
  }

  it('is all null before any season exists', async () => {
    expect(await getSeasonRanges(db, NOW)).toEqual({ current: null, previous: null });
  });

  it('returns the running season as current, with its end clamped to now', async () => {
    await seedSeason(1, '2026-10-01T00:00:00Z', '2026-11-30T00:00:00Z', 'active');

    const { current, previous } = await getSeasonRanges(db, NOW);

    expect(current?.seasonNumber).toBe(1);
    expect(current?.start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    // Not the season's own end date, which is still weeks away.
    expect(current?.end.toISOString()).toBe(NOW.toISOString());
    expect(previous).toBeNull();
  });

  it('pairs the running season with the one before it', async () => {
    await seedSeason(1, '2026-08-01T00:00:00Z', '2026-09-30T00:00:00Z', 'closed');
    await seedSeason(2, '2026-10-01T00:00:00Z', '2026-11-30T00:00:00Z', 'active');

    const { current, previous } = await getSeasonRanges(db, NOW);

    expect(current?.seasonNumber).toBe(2);
    expect(previous?.seasonNumber).toBe(1);
    // A finished season keeps its real end date — nothing to clamp.
    expect(previous?.end.toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  it('still reports the just-closed season as current in the gap before the next one starts', async () => {
    await seedSeason(1, '2026-08-01T00:00:00Z', '2026-09-30T00:00:00Z', 'closed');

    const { current } = await getSeasonRanges(db, NOW);

    expect(current?.seasonNumber).toBe(1);
    expect(current?.end.toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });
});

describe('hasAnySeason / getCurrentSeason', () => {
  it('reports no season and no current season on a fresh database', async () => {
    expect(await hasAnySeason(db)).toBe(false);
    expect(await getCurrentSeason(db)).toBeNull();
  });

  it('finds the active season once one exists', async () => {
    const [season] = await db
      .insert(seasons)
      .values({ seasonNumber: 1, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-03-01'), status: 'active' })
      .returning();
    expect(await hasAnySeason(db)).toBe(true);
    expect(await getCurrentSeason(db)).toMatchObject({ id: season!.id, seasonNumber: 1, status: 'active' });
  });
});

describe('startFirstSeason', () => {
  it('creates season 1 with the configured length, and logs it', async () => {
    const adminUserId = await seedAdmin();
    const now = new Date('2026-01-01T00:00:00Z');
    const result = await startFirstSeason(db, { lengthDays: 60, adminUserId, now });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.season).toMatchObject({
      seasonNumber: 1,
      startsAt: now,
      endsAt: new Date('2026-03-02T00:00:00Z'),
      status: 'active',
    });

    const [log] = await db.select().from(auditLog);
    expect(log).toMatchObject({ adminUserId, action: 'season.start_first', entityId: result.season.id });
  });

  it('refuses to start a second "first" season once any season exists', async () => {
    const adminUserId = await seedAdmin();
    await startFirstSeason(db, { lengthDays: 60, adminUserId });
    const second = await startFirstSeason(db, { lengthDays: 60, adminUserId });
    expect(second).toEqual({ ok: false, reason: 'already_exists' });
  });

  it('refuses even when the only existing season is already closed', async () => {
    const adminUserId = await seedAdmin();
    await db.insert(seasons).values({
      seasonNumber: 1,
      startsAt: new Date('2025-01-01'),
      endsAt: new Date('2025-03-01'),
      status: 'closed',
      closedAt: new Date('2025-03-01'),
    });
    const result = await startFirstSeason(db, { lengthDays: 60, adminUserId });
    expect(result).toEqual({ ok: false, reason: 'already_exists' });
  });
});

describe('listSeasonHistory', () => {
  it('is empty when nothing has closed yet', async () => {
    await db.insert(seasons).values({ seasonNumber: 1, startsAt: new Date(), endsAt: new Date(), status: 'active' });
    expect(await listSeasonHistory(db)).toEqual([]);
  });

  it('returns closed seasons with their podium, newest first', async () => {
    const [profile] = await db.insert(playerProfiles).values({ playerId: '100001', email: 'p100001@test.levelup' }).returning();
    const [seasonA] = await db
      .insert(seasons)
      .values({ seasonNumber: 1, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-03-01'), status: 'closed', closedAt: new Date('2026-03-01') })
      .returning();
    const [seasonB] = await db
      .insert(seasons)
      .values({ seasonNumber: 2, startsAt: new Date('2026-03-01'), endsAt: new Date('2026-05-01'), status: 'closed', closedAt: new Date('2026-05-01') })
      .returning();
    await db.insert(hallOfFameEntries).values([
      { seasonId: seasonA!.id, position: 1, playerProfileId: profile!.id, displayNameSnapshot: 'Champ', seasonalDiamonds: 10_000 },
      { seasonId: seasonB!.id, position: 1, playerProfileId: profile!.id, displayNameSnapshot: 'Champ2', seasonalDiamonds: 20_000 },
    ]);

    const history = await listSeasonHistory(db);
    expect(history.map((h) => h.seasonNumber)).toEqual([2, 1]);
    expect(history[0]?.podium).toEqual([
      {
        position: 1,
        playerProfileId: profile!.id,
        displayName: 'Champ2',
        avatarAssetUrlSnapshot: null,
        seasonalDiamonds: 20_000,
      },
    ]);
  });
});
