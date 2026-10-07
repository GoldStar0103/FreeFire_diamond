/** Customer OTP codes and player profiles against real Postgres. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { badgeDefinitions, badgeOwnerships } from '../schema.js';
import {
  awardFounderBadgeIfEligible,
  consumeOtpCode,
  createOtpCode,
  createPlayerProfile,
  findActiveOtpCode,
  findProfileByPlayerId,
  findProfileByEmail,
  incrementOtpAttempts,
} from './customer-auth-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_customer_auth_test';

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
  await db.execute(raw`TRUNCATE player_profiles, player_otp_codes, badge_definitions, badge_ownerships RESTART IDENTITY CASCADE`);
});

describe('OTP codes', () => {
  it('finds a freshly created code as active', async () => {
    await createOtpCode(db, 'jose@levelup.mx', 'hash-1', new Date(Date.now() + 600_000));
    const found = await findActiveOtpCode(db, 'jose@levelup.mx');
    expect(found).toMatchObject({ email: 'jose@levelup.mx', codeHash: 'hash-1', attempts: 0, consumedAt: null });
  });

  it('does not find an expired code', async () => {
    await createOtpCode(db, 'jose@levelup.mx', 'hash-1', new Date(Date.now() - 1_000));
    expect(await findActiveOtpCode(db, 'jose@levelup.mx')).toBeNull();
  });

  it('does not find an already-consumed code', async () => {
    const code = await createOtpCode(db, 'jose@levelup.mx', 'hash-1', new Date(Date.now() + 600_000));
    await consumeOtpCode(db, code.id);
    expect(await findActiveOtpCode(db, 'jose@levelup.mx')).toBeNull();
  });

  it('returns the newest code when several exist for the same number', async () => {
    await createOtpCode(db, 'jose@levelup.mx', 'hash-old', new Date(Date.now() + 600_000));
    await new Promise((r) => setTimeout(r, 5));
    await createOtpCode(db, 'jose@levelup.mx', 'hash-new', new Date(Date.now() + 600_000));

    const found = await findActiveOtpCode(db, 'jose@levelup.mx');
    expect(found?.codeHash).toBe('hash-new');
  });

  it('increments attempts and returns the new count', async () => {
    const code = await createOtpCode(db, 'jose@levelup.mx', 'hash-1', new Date(Date.now() + 600_000));
    expect(await incrementOtpAttempts(db, code.id)).toBe(1);
    expect(await incrementOtpAttempts(db, code.id)).toBe(2);
  });

  it('consumeOtpCode succeeds once and refuses a second call (compare-and-set)', async () => {
    const code = await createOtpCode(db, 'jose@levelup.mx', 'hash-1', new Date(Date.now() + 600_000));
    expect(await consumeOtpCode(db, code.id)).toBe(true);
    expect(await consumeOtpCode(db, code.id)).toBe(false);
  });
});

describe('player profiles', () => {
  it('creates a profile and finds it by email and by player id', async () => {
    const result = await createPlayerProfile(db, { playerId: '100001', email: 'jose@levelup.mx' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(await findProfileByEmail(db, 'jose@levelup.mx')).toMatchObject({ playerId: '100001' });
    expect(await findProfileByPlayerId(db, '100001')).toMatchObject({ email: 'jose@levelup.mx' });
  });

  it('returns null for an unknown email or player id', async () => {
    expect(await findProfileByEmail(db, 'nadie@levelup.mx')).toBeNull();
    expect(await findProfileByPlayerId(db, '999999')).toBeNull();
  });

  it('refuses a second account for an already-used email', async () => {
    await createPlayerProfile(db, { playerId: '100001', email: 'jose@levelup.mx' });
    const second = await createPlayerProfile(db, { playerId: '100002', email: 'jose@levelup.mx' });
    expect(second).toEqual({ ok: false, reason: 'email_taken' });
  });

  it('refuses a second account for an already-linked Free Fire ID', async () => {
    await createPlayerProfile(db, { playerId: '100001', email: 'jose@levelup.mx' });
    const second = await createPlayerProfile(db, { playerId: '100001', email: 'otro@levelup.mx' });
    expect(second).toEqual({ ok: false, reason: 'player_id_taken' });
  });
});

describe('awardFounderBadgeIfEligible', () => {
  it('does nothing when no "founder" badge is defined', async () => {
    const { profile } = (await createPlayerProfile(db, { playerId: '100001', email: 'jose@levelup.mx' })) as { profile: { id: string } };
    await expect(awardFounderBadgeIfEligible(db, profile.id)).resolves.not.toThrow();
    expect(await db.select().from(badgeOwnerships)).toEqual([]);
  });

  it('awards the badge when now is inside the eligibility window', async () => {
    const { profile } = (await createPlayerProfile(db, { playerId: '100001', email: 'jose@levelup.mx' })) as { profile: { id: string } };
    const [badge] = await db
      .insert(badgeDefinitions)
      .values({
        badgeKey: 'founder',
        title: 'Founder',
        category: 'special',
        eligibilityStartsAt: new Date('2026-01-01'),
        eligibilityEndsAt: new Date('2026-02-01'),
      })
      .returning();

    await awardFounderBadgeIfEligible(db, profile.id, new Date('2026-01-15'));

    const [ownership] = await db.select().from(badgeOwnerships);
    expect(ownership).toMatchObject({ playerProfileId: profile.id, badgeDefinitionId: badge!.id, seasonId: null });
  });

  it('does not award the badge before the eligibility window opens', async () => {
    const { profile } = (await createPlayerProfile(db, { playerId: '100001', email: 'jose@levelup.mx' })) as { profile: { id: string } };
    await db.insert(badgeDefinitions).values({
      badgeKey: 'founder',
      title: 'Founder',
      category: 'special',
      eligibilityStartsAt: new Date('2026-01-01'),
      eligibilityEndsAt: new Date('2026-02-01'),
    });

    await awardFounderBadgeIfEligible(db, profile.id, new Date('2025-12-31'));
    expect(await db.select().from(badgeOwnerships)).toEqual([]);
  });

  it('does not award the badge after the eligibility window closes', async () => {
    const { profile } = (await createPlayerProfile(db, { playerId: '100001', email: 'jose@levelup.mx' })) as { profile: { id: string } };
    await db.insert(badgeDefinitions).values({
      badgeKey: 'founder',
      title: 'Founder',
      category: 'special',
      eligibilityStartsAt: new Date('2026-01-01'),
      eligibilityEndsAt: new Date('2026-02-01'),
    });

    await awardFounderBadgeIfEligible(db, profile.id, new Date('2026-02-02'));
    expect(await db.select().from(badgeOwnerships)).toEqual([]);
  });

  it('does not award a badge marked not obtainable', async () => {
    const { profile } = (await createPlayerProfile(db, { playerId: '100001', email: 'jose@levelup.mx' })) as { profile: { id: string } };
    await db.insert(badgeDefinitions).values({ badgeKey: 'founder', title: 'Founder', category: 'special', obtainable: false });

    await awardFounderBadgeIfEligible(db, profile.id);
    expect(await db.select().from(badgeOwnerships)).toEqual([]);
  });

  it('never awards it twice for the same profile', async () => {
    const { profile } = (await createPlayerProfile(db, { playerId: '100001', email: 'jose@levelup.mx' })) as { profile: { id: string } };
    await db.insert(badgeDefinitions).values({ badgeKey: 'founder', title: 'Founder', category: 'special' });

    await awardFounderBadgeIfEligible(db, profile.id);
    await awardFounderBadgeIfEligible(db, profile.id);

    expect(await db.select().from(badgeOwnerships)).toHaveLength(1);
  });
});
