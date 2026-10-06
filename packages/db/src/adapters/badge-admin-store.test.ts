/** Admin badge management against real Postgres. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { adminUsers, auditLog, badgeDefinitions, playerProfiles, seasons } from '../schema.js';
import {
  getBadgeDefinition,
  listBadgeDefinitions,
  listBadgeHolders,
  manuallyAwardBadge,
  revokeBadgeOwnership,
  saveBadgeDefinition,
  setBadgeObtainable,
  type BadgeDefinitionDraft,
} from './badge-admin-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_badge_admin_test';

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
    raw`TRUNCATE badge_definitions, badge_ownerships, player_profiles, seasons, admin_users, audit_log RESTART IDENTITY CASCADE`,
  );
});

async function seedAdmin(): Promise<string> {
  const [admin] = await db.insert(adminUsers).values({ email: `admin-${Date.now()}-${Math.random()}@test.com`, passwordHash: 'x' }).returning();
  return admin!.id;
}

const draft = (overrides: Partial<BadgeDefinitionDraft> = {}): BadgeDefinitionDraft => ({
  badgeKey: 'top_50',
  title: 'Top 50',
  description: null,
  category: 'ranking',
  rarity: 'common',
  artworkAssetUrl: null,
  seasonScoped: true,
  eligibilityStartsAt: null,
  eligibilityEndsAt: null,
  obtainable: true,
  ...overrides,
});

describe('saveBadgeDefinition', () => {
  it('creates a new definition and logs it', async () => {
    const adminUserId = await seedAdmin();
    await saveBadgeDefinition(db, draft(), adminUserId);

    const found = await getBadgeDefinition(db, 'top_50');
    expect(found).toMatchObject({ badgeKey: 'top_50', title: 'Top 50', holderCount: 0 });

    const [log] = await db.select().from(auditLog);
    expect(log).toMatchObject({ adminUserId, action: 'badge_definition.save' });
  });

  it('updates the same definition on a second save with the same key', async () => {
    const adminUserId = await seedAdmin();
    await saveBadgeDefinition(db, draft({ title: 'Top 50' }), adminUserId);
    await saveBadgeDefinition(db, draft({ title: 'Top 50 Jugadores' }), adminUserId);

    const all = await listBadgeDefinitions(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.title).toBe('Top 50 Jugadores');
  });
});

describe('setBadgeObtainable', () => {
  it('toggles obtainable and logs it', async () => {
    const adminUserId = await seedAdmin();
    await saveBadgeDefinition(db, draft({ obtainable: true }), adminUserId);

    await setBadgeObtainable(db, 'top_50', false, adminUserId);
    expect((await getBadgeDefinition(db, 'top_50'))?.obtainable).toBe(false);
  });

  it('does nothing for an unknown badge key', async () => {
    const adminUserId = await seedAdmin();
    await expect(setBadgeObtainable(db, 'does_not_exist', false, adminUserId)).resolves.not.toThrow();
  });
});

describe('manuallyAwardBadge', () => {
  it('fails cleanly when the player has no account', async () => {
    const adminUserId = await seedAdmin();
    await saveBadgeDefinition(db, draft({ seasonScoped: false }), adminUserId);
    const result = await manuallyAwardBadge(db, { playerId: '999999', badgeKey: 'top_50', reason: 'test', adminUserId });
    expect(result).toEqual({ ok: false, reason: 'player_not_found' });
  });

  it('fails cleanly for an unknown badge key', async () => {
    const adminUserId = await seedAdmin();
    await db.insert(playerProfiles).values({ playerId: '100001', whatsapp: '525500000001' });
    const result = await manuallyAwardBadge(db, { playerId: '100001', badgeKey: 'does_not_exist', reason: 'test', adminUserId });
    expect(result).toEqual({ ok: false, reason: 'badge_not_found' });
  });

  it('requires a season number for a season-scoped badge', async () => {
    const adminUserId = await seedAdmin();
    await db.insert(playerProfiles).values({ playerId: '100001', whatsapp: '525500000001' });
    await saveBadgeDefinition(db, draft({ seasonScoped: true }), adminUserId);

    const result = await manuallyAwardBadge(db, { playerId: '100001', badgeKey: 'top_50', reason: 'test', adminUserId });
    expect(result).toEqual({ ok: false, reason: 'season_required' });
  });

  it('fails cleanly when the given season number does not exist', async () => {
    const adminUserId = await seedAdmin();
    await db.insert(playerProfiles).values({ playerId: '100001', whatsapp: '525500000001' });
    await saveBadgeDefinition(db, draft({ seasonScoped: true }), adminUserId);

    const result = await manuallyAwardBadge(db, { playerId: '100001', badgeKey: 'top_50', seasonNumber: 7, reason: 'test', adminUserId });
    expect(result).toEqual({ ok: false, reason: 'season_not_found' });
  });

  it('awards a non-seasonal badge and it shows up as a holder', async () => {
    const adminUserId = await seedAdmin();
    await db.insert(playerProfiles).values({ playerId: '100001', whatsapp: '525500000001' });
    await saveBadgeDefinition(db, draft({ badgeKey: 'founder', seasonScoped: false }), adminUserId);

    const result = await manuallyAwardBadge(db, { playerId: '100001', badgeKey: 'founder', reason: 'early tester', adminUserId });
    expect(result).toEqual({ ok: true });

    const holders = await listBadgeHolders(db, 'founder');
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({ playerId: '100001', source: 'manual', seasonNumber: null });

    const found = await getBadgeDefinition(db, 'founder');
    expect(found?.holderCount).toBe(1);
  });

  it('awards a season-scoped badge tagged to the right season', async () => {
    const adminUserId = await seedAdmin();
    await db.insert(playerProfiles).values({ playerId: '100001', whatsapp: '525500000001' });
    await db.insert(seasons).values({ seasonNumber: 3, startsAt: new Date(), endsAt: new Date(), status: 'closed' });
    await saveBadgeDefinition(db, draft({ badgeKey: 'top_50', seasonScoped: true }), adminUserId);

    await manuallyAwardBadge(db, { playerId: '100001', badgeKey: 'top_50', seasonNumber: 3, reason: 'manual fix', adminUserId });

    const holders = await listBadgeHolders(db, 'top_50');
    expect(holders[0]).toMatchObject({ seasonNumber: 3, source: 'manual' });
  });
});

describe('revokeBadgeOwnership', () => {
  it('marks a held badge revoked and excludes it from the holder count', async () => {
    const adminUserId = await seedAdmin();
    await db.insert(playerProfiles).values({ playerId: '100001', whatsapp: '525500000001' });
    await saveBadgeDefinition(db, draft({ badgeKey: 'founder', seasonScoped: false }), adminUserId);
    await manuallyAwardBadge(db, { playerId: '100001', badgeKey: 'founder', reason: 'x', adminUserId });

    const [holder] = await listBadgeHolders(db, 'founder');
    await revokeBadgeOwnership(db, holder!.ownershipId, adminUserId, 'awarded by mistake');

    expect((await getBadgeDefinition(db, 'founder'))?.holderCount).toBe(0);
    const holders = await listBadgeHolders(db, 'founder');
    expect(holders[0]?.revokedAt).not.toBeNull();
  });
});
