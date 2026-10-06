/** `DrizzleSeasonStore` against real Postgres. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import type { SeasonClosePlan } from '@levelup/engine';
import { createDb, type Database } from '../index.js';
import {
  badgeDefinitions,
  badgeOwnerships,
  hallOfFameEntries,
  playerProfiles,
  seasonPlayerStats,
  seasons,
  vaultEntitlements,
} from '../schema.js';
import { DrizzleSeasonStore } from './season-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_season_store_test';

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
    raw`TRUNCATE player_profiles, seasons, season_player_stats, hall_of_fame_entries,
        badge_definitions, badge_ownerships, vault_entitlements, settings
        RESTART IDENTITY CASCADE`,
  );
});

async function seedProfile(playerId: string, displayName: string) {
  const [profile] = await db
    .insert(playerProfiles)
    .values({ playerId, whatsapp: `+52${playerId}`, displayName })
    .returning();
  return profile!;
}

async function seedSeason(overrides: Partial<typeof seasons.$inferInsert> = {}) {
  const [season] = await db
    .insert(seasons)
    .values({
      seasonNumber: 1,
      startsAt: new Date('2026-01-01'),
      endsAt: new Date('2026-03-01'),
      status: 'active',
      ...overrides,
    })
    .returning();
  return season!;
}

describe('findDueSeasons', () => {
  it('returns an active season whose end date has already passed', async () => {
    const season = await seedSeason({ endsAt: new Date('2026-03-01') });
    const store = new DrizzleSeasonStore(db);

    const due = await store.findDueSeasons(new Date('2026-03-02'));
    expect(due).toEqual([{ id: season.id, seasonNumber: 1, endsAt: season.endsAt }]);
  });

  it('does not return a season whose end date is still in the future', async () => {
    await seedSeason({ endsAt: new Date('2026-03-01') });
    const store = new DrizzleSeasonStore(db);

    expect(await store.findDueSeasons(new Date('2026-02-01'))).toEqual([]);
  });

  it('does not return an already-closed season', async () => {
    await seedSeason({ endsAt: new Date('2026-03-01'), status: 'closed', closedAt: new Date('2026-03-01') });
    const store = new DrizzleSeasonStore(db);

    expect(await store.findDueSeasons(new Date('2026-03-02'))).toEqual([]);
  });
});

describe('getSeasonRanking', () => {
  it('orders players by seasonal diamonds, descending', async () => {
    const season = await seedSeason();
    const low = await seedProfile('100001', 'Low');
    const high = await seedProfile('100002', 'High');
    await db.insert(seasonPlayerStats).values([
      { seasonId: season.id, playerProfileId: low.id, seasonalDiamonds: 100 },
      { seasonId: season.id, playerProfileId: high.id, seasonalDiamonds: 9_999 },
    ]);

    const store = new DrizzleSeasonStore(db);
    const ranking = await store.getSeasonRanking(season.id);

    expect(ranking.map((r) => r.playerProfileId)).toEqual([high.id, low.id]);
    expect(ranking[0]).toMatchObject({ displayName: 'High', seasonalDiamonds: 9_999 });
  });

  it('is empty for a season nobody has played in', async () => {
    const season = await seedSeason();
    const store = new DrizzleSeasonStore(db);
    expect(await store.getSeasonRanking(season.id)).toEqual([]);
  });
});

describe('closeSeason', () => {
  function plan(overrides: Partial<SeasonClosePlan>, seasonId: string): SeasonClosePlan {
    return {
      seasonId,
      hallOfFame: [],
      badgeAwards: [],
      nextSeasonNumber: 2,
      nextSeasonStartsAt: new Date('2026-03-01'),
      nextSeasonEndsAt: new Date('2026-05-01'),
      ...overrides,
    };
  }

  it('inserts the Hall of Fame entries', async () => {
    const season = await seedSeason();
    const champ = await seedProfile('100001', 'Champ');
    const store = new DrizzleSeasonStore(db);

    await store.closeSeason(
      plan(
        {
          hallOfFame: [
            { position: 1, playerProfileId: champ.id, displayNameSnapshot: 'Champ', avatarAssetUrlSnapshot: null, seasonalDiamonds: 10_000 },
          ],
        },
        season.id,
      ),
    );

    const rows = await db.select().from(hallOfFameEntries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seasonId: season.id, position: 1, playerProfileId: champ.id, seasonalDiamonds: 10_000 });
  });

  it('awards a badge when its definition exists, by the current season', async () => {
    const season = await seedSeason();
    const champ = await seedProfile('100001', 'Champ');
    const [badgeDef] = await db
      .insert(badgeDefinitions)
      .values({ badgeKey: 'season_champion', title: 'Season Champion', category: 'ranking', seasonScoped: true })
      .returning();
    const store = new DrizzleSeasonStore(db);

    await store.closeSeason(
      plan(
        { badgeAwards: [{ playerProfileId: champ.id, badgeKey: 'season_champion', achievementData: { finalPosition: 1 } }] },
        season.id,
      ),
    );

    const [ownership] = await db.select().from(badgeOwnerships);
    expect(ownership).toMatchObject({
      playerProfileId: champ.id,
      badgeDefinitionId: badgeDef!.id,
      seasonId: season.id,
      achievementData: { finalPosition: 1 },
      source: 'automatic',
    });
  });

  it('skips a badge award gracefully when its definition does not exist, without failing the whole close', async () => {
    const season = await seedSeason();
    const player = await seedProfile('100001', 'Someone');
    const store = new DrizzleSeasonStore(db);

    await expect(
      store.closeSeason(
        plan({ badgeAwards: [{ playerProfileId: player.id, badgeKey: 'top_50', achievementData: { finalPosition: 40 } }] }, season.id),
      ),
    ).resolves.not.toThrow();

    expect(await db.select().from(badgeOwnerships)).toEqual([]);
    const [closed] = await db.select().from(seasons).where(eq(seasons.id, season.id));
    expect(closed?.status).toBe('closed'); // the rest of the close still happened
  });

  it('expires every active Vault entitlement for the season, leaving other seasons untouched', async () => {
    const season = await seedSeason();
    const otherSeason = await seedSeason({ seasonNumber: 99, status: 'active' });
    const player = await seedProfile('100001', 'Someone');
    await db.insert(vaultEntitlements).values([
      { seasonId: season.id, playerProfileId: player.id, status: 'active', expiresAt: season.endsAt },
      { seasonId: otherSeason.id, playerProfileId: player.id, status: 'active', expiresAt: otherSeason.endsAt },
    ]);
    const store = new DrizzleSeasonStore(db);

    await store.closeSeason(plan({}, season.id));

    const rows = await db.select().from(vaultEntitlements);
    const thisOne = rows.find((r) => r.seasonId === season.id);
    const otherOne = rows.find((r) => r.seasonId === otherSeason.id);
    expect(thisOne?.status).toBe('expired');
    expect(otherOne?.status).toBe('active');
  });

  it('marks the season closed and opens the next one, active', async () => {
    const season = await seedSeason();
    const store = new DrizzleSeasonStore(db);

    await store.closeSeason(
      plan({ nextSeasonNumber: 2, nextSeasonStartsAt: new Date('2026-03-01'), nextSeasonEndsAt: new Date('2026-05-01') }, season.id),
    );

    const [closed] = await db.select().from(seasons).where(eq(seasons.id, season.id));
    expect(closed).toMatchObject({ status: 'closed' });
    expect(closed?.closedAt).not.toBeNull();

    const [next] = await db.select().from(seasons).where(eq(seasons.seasonNumber, 2));
    expect(next).toMatchObject({ status: 'active', seasonNumber: 2 });
  });
});
