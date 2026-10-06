/** Mi LevelUp read/write surface against real Postgres. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import {
  badgeDefinitions,
  badgeOwnerships,
  campaigns,
  combos,
  levelPassCheckpointEvents,
  orders,
  playerProfiles,
  seasonPlayerStats,
  seasons,
  vaultEntitlements,
  vaultOffers,
} from '../schema.js';
import {
  getMyLevelUpOverview,
  getMyProfile,
  getPublicProfile,
  getPublicTop50,
  listMyBadges,
  listMyOrders,
  reviewDisplayName,
  setFeaturedBadges,
  updateAvatar,
  updateDisplayName,
} from './customer-profile-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_customer_profile_test';

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
    raw`TRUNCATE player_profiles, seasons, season_player_stats, level_pass_checkpoint_events,
        vault_entitlements, vault_offers, combos, campaigns, badge_definitions, badge_ownerships,
        featured_badges, orders, level_pass_lp_transactions, order_items, settings
        RESTART IDENTITY CASCADE`,
  );
});

async function seedProfile(playerId = '100001', whatsapp = '525500000001') {
  const [p] = await db.insert(playerProfiles).values({ playerId, whatsapp }).returning();
  return p!;
}

async function seedActiveSeason(seasonNumber = 1) {
  const [s] = await db
    .insert(seasons)
    .values({ seasonNumber, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-03-01'), status: 'active' })
    .returning();
  return s!;
}

describe('getMyProfile', () => {
  it('returns null for an unknown id', async () => {
    expect(await getMyProfile(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('returns the profile', async () => {
    const p = await seedProfile();
    expect(await getMyProfile(db, p.id)).toMatchObject({ playerId: '100001' });
  });
});

describe('getMyLevelUpOverview', () => {
  it('returns an all-zero, no-season overview when there is no active season', async () => {
    const p = await seedProfile();
    const overview = await getMyLevelUpOverview(db, p.id);
    expect(overview).toMatchObject({ season: null, lp: 0, seasonalDiamonds: 0, rank: null, checkpoints: [], vault: { unlocked: false } });
  });

  it('reflects season stats, rank, and checkpoint progress', async () => {
    const low = await seedProfile('100001', '525500000001');
    const high = await seedProfile('100002', '525500000002');
    const season = await seedActiveSeason();

    await db.insert(seasonPlayerStats).values([
      { seasonId: season.id, playerProfileId: low.id, lp: 60, seasonalDiamonds: 100 },
      { seasonId: season.id, playerProfileId: high.id, lp: 300, seasonalDiamonds: 9_999 },
    ]);
    await db.insert(levelPassCheckpointEvents).values({
      seasonId: season.id,
      playerProfileId: low.id,
      checkpointLp: 60,
      rewardDiamonds: 110,
      internalCostCents: 1_200,
      status: 'pending',
    });

    const overview = await getMyLevelUpOverview(db, low.id);
    expect(overview.season).toMatchObject({ seasonNumber: 1 });
    expect(overview.lp).toBe(60);
    expect(overview.seasonalDiamonds).toBe(100);
    expect(overview.rank).toBe(2); // behind `high`
    expect(overview.checkpoints[0]).toMatchObject({ lp: 60, reached: true, status: 'pending' });
    expect(overview.checkpoints[1]).toMatchObject({ lp: 260, reached: false, status: null });
  });

  it('includes Vault offers only when the entitlement is active', async () => {
    const p = await seedProfile();
    const season = await seedActiveSeason();
    const [campaign] = await db.insert(campaigns).values({ key: 'c', name: 'C' }).returning();
    const [combo] = await db.insert(combos).values({ campaignId: campaign!.id, key: 'combo1', name: 'Combo Uno', priceMxnCents: 10_000, advertisedDiamonds: 100, active: true }).returning();
    const [offer] = await db.insert(vaultOffers).values({ comboId: combo!.id, vaultPriceMxnCents: 7_000, active: true }).returning();

    const withoutEntitlement = await getMyLevelUpOverview(db, p.id);
    expect(withoutEntitlement.vault).toEqual({ unlocked: false, expiresAt: null, offers: [] });

    await db.insert(vaultEntitlements).values({ seasonId: season.id, playerProfileId: p.id, status: 'active', expiresAt: season.endsAt });
    const withEntitlement = await getMyLevelUpOverview(db, p.id);
    expect(withEntitlement.vault.unlocked).toBe(true);
    expect(withEntitlement.vault.offers).toEqual([
      { vaultOfferId: offer!.id, comboKey: 'combo1', comboName: 'Combo Uno', publicPriceMxnCents: 10_000, vaultPriceMxnCents: 7_000 },
    ]);
  });

  it('does not show an expired Vault entitlement as unlocked', async () => {
    const p = await seedProfile();
    const season = await seedActiveSeason();
    await db.insert(vaultEntitlements).values({ seasonId: season.id, playerProfileId: p.id, status: 'expired', expiresAt: season.endsAt });

    const overview = await getMyLevelUpOverview(db, p.id);
    expect(overview.vault.unlocked).toBe(false);
  });
});

describe('listMyBadges / setFeaturedBadges', () => {
  it('lists owned, non-revoked badges with season number when applicable', async () => {
    const p = await seedProfile();
    const season = await seedActiveSeason();
    const [def] = await db.insert(badgeDefinitions).values({ badgeKey: 'top_50', title: 'Top 50', category: 'ranking', seasonScoped: true }).returning();
    await db.insert(badgeOwnerships).values({ playerProfileId: p.id, badgeDefinitionId: def!.id, seasonId: season.id, source: 'automatic' });

    const badges = await listMyBadges(db, p.id);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({ badgeKey: 'top_50', seasonNumber: 1, featured: false });
  });

  it('excludes a revoked badge', async () => {
    const p = await seedProfile();
    const [def] = await db.insert(badgeDefinitions).values({ badgeKey: 'founder', title: 'Founder', category: 'special' }).returning();
    await db.insert(badgeOwnerships).values({ playerProfileId: p.id, badgeDefinitionId: def!.id, seasonId: null, source: 'manual', revokedAt: new Date() });

    expect(await listMyBadges(db, p.id)).toEqual([]);
  });

  it('refuses to feature a badge another player owns', async () => {
    const owner = await seedProfile('100001', '525500000001');
    const stranger = await seedProfile('100002', '525500000002');
    const [def] = await db.insert(badgeDefinitions).values({ badgeKey: 'founder', title: 'Founder', category: 'special' }).returning();
    const [ownership] = await db.insert(badgeOwnerships).values({ playerProfileId: owner.id, badgeDefinitionId: def!.id, seasonId: null, source: 'manual' }).returning();

    const result = await setFeaturedBadges(db, stranger.id, [ownership!.id]);
    expect(result).toEqual({ ok: false, reason: 'not_owned' });
  });

  it('refuses more than the maximum featured badges', async () => {
    const p = await seedProfile();
    const result = await setFeaturedBadges(db, p.id, ['a', 'b', 'c', 'd', 'e']);
    expect(result).toEqual({ ok: false, reason: 'too_many' });
  });

  it('sets and replaces the featured set, reflected in listMyBadges', async () => {
    const p = await seedProfile();
    const [def] = await db.insert(badgeDefinitions).values({ badgeKey: 'founder', title: 'Founder', category: 'special' }).returning();
    const [ownership] = await db.insert(badgeOwnerships).values({ playerProfileId: p.id, badgeDefinitionId: def!.id, seasonId: null, source: 'manual' }).returning();

    expect(await setFeaturedBadges(db, p.id, [ownership!.id])).toEqual({ ok: true });
    expect((await listMyBadges(db, p.id))[0]?.featured).toBe(true);

    expect(await setFeaturedBadges(db, p.id, [])).toEqual({ ok: true });
    expect((await listMyBadges(db, p.id))[0]?.featured).toBe(false);
  });
});

describe('listMyOrders', () => {
  it('lists orders newest first, with LP earned when it exists', async () => {
    const p = await seedProfile();
    const [campaign] = await db.insert(campaigns).values({ key: 'c', name: 'C' }).returning();
    const [combo] = await db.insert(combos).values({ campaignId: campaign!.id, key: 'combo1', name: 'Combo Uno', priceMxnCents: 10_000, advertisedDiamonds: 100, active: true }).returning();
    await db.insert(orders).values({
      orderNumber: 'LU-1', playerId: '100001', comboId: combo!.id, comboKey: 'combo1',
      comboSnapshot: { name: 'Combo Uno' }, priceMxnCents: 10_000, status: 'completed',
    });

    const list = await listMyOrders(db, '100001');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ orderNumber: 'LU-1', comboName: 'Combo Uno', lpEarned: null });
  });
});

describe('reviewDisplayName', () => {
  it.each(['ab', 'x'.repeat(21), 'bad<script>', ''])('rejects invalid input (%s)', (raw) => {
    expect(reviewDisplayName(raw).issue).not.toBeNull();
  });

  it('accepts a normal name, trimmed', () => {
    expect(reviewDisplayName('  ShadowFF  ')).toEqual({ displayName: 'ShadowFF', issue: null });
  });

  it('accepts accented letters and spaces', () => {
    expect(reviewDisplayName('José Ñandú').issue).toBeNull();
  });
});

describe('updateDisplayName', () => {
  it('updates on valid input', async () => {
    const p = await seedProfile();
    expect(await updateDisplayName(db, p.id, 'ShadowFF')).toEqual({ ok: true });
    expect((await getMyProfile(db, p.id))?.displayName).toBe('ShadowFF');
  });

  it('refuses invalid input without touching the row', async () => {
    const p = await seedProfile();
    const result = await updateDisplayName(db, p.id, 'ab');
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect((await getMyProfile(db, p.id))?.displayName).toBeNull();
  });

  it('refuses a name already taken by another player', async () => {
    const a = await seedProfile('100001', '525500000001');
    const b = await seedProfile('100002', '525500000002');
    await updateDisplayName(db, a.id, 'ShadowFF');

    const result = await updateDisplayName(db, b.id, 'ShadowFF');
    expect(result).toMatchObject({ ok: false, reason: 'taken' });
  });
});

describe('updateAvatar', () => {
  it('sets the avatar key', async () => {
    const p = await seedProfile();
    await updateAvatar(db, p.id, 'avatars/x/abc.jpg');
    expect((await getMyProfile(db, p.id))?.avatarAssetUrl).toBe('avatars/x/abc.jpg');
  });
});

describe('getPublicTop50', () => {
  it('is empty with no active season', async () => {
    expect(await getPublicTop50(db)).toEqual([]);
  });

  it('ranks by seasonal diamonds descending', async () => {
    const low = await seedProfile('100001', '525500000001');
    const high = await seedProfile('100002', '525500000002');
    const season = await seedActiveSeason();
    await db.insert(seasonPlayerStats).values([
      { seasonId: season.id, playerProfileId: low.id, seasonalDiamonds: 100 },
      { seasonId: season.id, playerProfileId: high.id, seasonalDiamonds: 9_999 },
    ]);

    const top = await getPublicTop50(db);
    expect(top.map((r) => r.playerProfileId)).toEqual([high.id, low.id]);
    expect(top[0]).toMatchObject({ rank: 1, seasonalDiamonds: 9_999 });
  });
});

describe('getPublicProfile', () => {
  it('returns null for an unknown profile', async () => {
    expect(await getPublicProfile(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('never exposes whatsapp or player id — only the documented public fields', async () => {
    const p = await seedProfile();
    const result = await getPublicProfile(db, p.id);
    expect(result).not.toBeNull();
    expect(Object.keys(result!)).toEqual([
      'displayName', 'avatarAssetUrl', 'memberSinceYear', 'currentRank', 'currentSeasonalDiamonds',
      'levelPassesCompleted', 'highestHistoricalRank', 'seasonsParticipatedIn', 'featuredBadges',
    ]);
  });

  it('counts a Vault entitlement as one completed Level Pass', async () => {
    const p = await seedProfile();
    const season = await seedActiveSeason();
    await db.insert(vaultEntitlements).values({ seasonId: season.id, playerProfileId: p.id, status: 'expired', expiresAt: season.endsAt });

    const result = await getPublicProfile(db, p.id);
    expect(result?.levelPassesCompleted).toBe(1);
  });

  it('reports the best rank across every season the player has stats in', async () => {
    const p = await seedProfile();
    const other = await seedProfile('100002', '525500000002');
    const seasonA = await seedActiveSeason(1);
    await db.update(seasons).set({ status: 'closed' }).where(eq(seasons.id, seasonA.id));
    const seasonB = await seedActiveSeason(2);

    // Season A: p is #1 (ahead of other). Season B: p is #2 (behind other).
    await db.insert(seasonPlayerStats).values([
      { seasonId: seasonA.id, playerProfileId: p.id, seasonalDiamonds: 1_000 },
      { seasonId: seasonA.id, playerProfileId: other.id, seasonalDiamonds: 500 },
      { seasonId: seasonB.id, playerProfileId: p.id, seasonalDiamonds: 100 },
      { seasonId: seasonB.id, playerProfileId: other.id, seasonalDiamonds: 9_999 },
    ]);

    const result = await getPublicProfile(db, p.id);
    expect(result?.highestHistoricalRank).toBe(1);
    expect(result?.seasonsParticipatedIn).toBe(2);
    expect(result?.currentRank).toBe(2); // season B is the active one
  });
});
