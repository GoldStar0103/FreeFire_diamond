/** Manual LP override against real Postgres. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import {
  adminUsers,
  auditLog,
  badgeDefinitions,
  badgeOwnerships,
  levelPassCheckpointEvents,
  levelPassLpTransactions,
  orders,
  playerProfiles,
  seasonPlayerStats,
  seasons,
  vaultEntitlements,
} from '../schema.js';
import { overrideOrderLp } from './lp-override-store.js';
import { saveLevelPassCheckpoints } from './level-pass-settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_lp_override_test';

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

let adminId: string;
let seasonId: string;
let profileId: string;

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(
    raw`TRUNCATE seasons, player_profiles, season_player_stats, level_pass_lp_transactions,
        level_pass_checkpoint_events, vault_entitlements, badge_definitions, badge_ownerships,
        orders, audit_log, admin_users, settings RESTART IDENTITY CASCADE`,
  );
  await saveLevelPassCheckpoints(db, [
    { lp: 60, rewardDiamonds: 110, costCents: 1_200, recipe: [] },
    { lp: 260, rewardDiamonds: 340, costCents: 4_000, recipe: [] },
  ]);
  const [admin] = await db
    .insert(adminUsers)
    .values({ email: `admin-${Math.random()}@test.com`, passwordHash: 'x' })
    .returning();
  adminId = admin!.id;

  const [season] = await db
    .insert(seasons)
    .values({ seasonNumber: 1, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-03-01'), status: 'active' })
    .returning();
  seasonId = season!.id;

  const [profile] = await db
    .insert(playerProfiles)
    .values({ playerId: '100001', email: 'p@test.levelup' })
    .returning();
  profileId = profile!.id;
}, 60_000);

/** An order already credited with `awardedLp`, and the season total to match. */
async function creditedOrder(awardedLp: number, currentLp = awardedLp) {
  const [order] = await db
    .insert(orders)
    .values({
      orderNumber: `LU-${Math.random().toString(36).slice(2, 10)}`,
      playerId: '100001',
      playerProfileId: profileId,
      comboKey: 'test_combo',
      comboSnapshot: { name: 'Pack' },
      priceMxnCents: 10_000,
      status: 'completed',
      completedAt: new Date('2026-02-01'),
    })
    .returning();

  await db.insert(levelPassLpTransactions).values({
    orderId: order!.id,
    seasonId,
    playerProfileId: profileId,
    saleAmountCents: 10_000,
    productCostCents: 2_000,
    paymentFeeCents: 0,
    estimatedProfitCents: 8_000,
    calculatedLp: awardedLp,
    awardedLp,
    diamonds: 100,
    rankingDiamonds: 100,
  });

  await db.insert(seasonPlayerStats).values({
    seasonId,
    playerProfileId: profileId,
    lp: currentLp,
    seasonalDiamonds: 100,
  });

  return order!;
}

const lpNow = async () => {
  const [row] = await db.select().from(seasonPlayerStats).where(eq(seasonPlayerStats.playerProfileId, profileId));
  return row?.lp ?? 0;
};

describe.skipIf(!PG_AVAILABLE)('overrideOrderLp', () => {
  it('refuses an order with no Level Pass transaction', async () => {
    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: 'LU-NOLP',
        playerId: '100001',
        comboKey: 'test_combo',
        comboSnapshot: { name: 'Pack' },
        priceMxnCents: 10_000,
        status: 'completed',
      })
      .returning();

    expect(await overrideOrderLp(db, { orderId: order!.id, adminUserId: adminId, newAwardedLp: 10 })).toEqual({
      ok: false,
      reason: 'no_lp_transaction',
    });
  });

  it('refuses a negative, fractional or absurd value', async () => {
    const order = await creditedOrder(10);
    for (const lp of [-1, 1.5, 100_001]) {
      expect(await overrideOrderLp(db, { orderId: order.id, adminUserId: adminId, newAwardedLp: lp })).toEqual({
        ok: false,
        reason: 'invalid_lp',
      });
    }
    expect(await lpNow()).toBe(10);
  });

  it('refuses to edit an order whose money was given back', async () => {
    const order = await creditedOrder(10);
    await db
      .update(levelPassLpTransactions)
      .set({ reversedAt: new Date() })
      .where(eq(levelPassLpTransactions.orderId, order.id));

    expect(await overrideOrderLp(db, { orderId: order.id, adminUserId: adminId, newAwardedLp: 50 })).toEqual({
      ok: false,
      reason: 'reversed',
    });
  });

  it('raises the award and the season total by the delta, keeping the calculated value', async () => {
    const order = await creditedOrder(10, 100);

    const result = await overrideOrderLp(db, {
      orderId: order.id,
      adminUserId: adminId,
      newAwardedLp: 50,
      reason: 'Compensación por entrega tardía',
    });

    expect(result.ok).toBe(true);
    expect(await lpNow()).toBe(140);

    const [lpTx] = await db.select().from(levelPassLpTransactions);
    expect(lpTx?.awardedLp).toBe(50);
    expect(lpTx?.calculatedLp).toBe(10); // the formula's answer is preserved
    expect(lpTx?.overriddenByAdminId).toBe(adminId);
    expect(lpTx?.overrideReason).toBe('Compensación por entrega tardía');
  });

  it('lowers the total and never below zero', async () => {
    const order = await creditedOrder(80, 50);

    await overrideOrderLp(db, { orderId: order.id, adminUserId: adminId, newAwardedLp: 0 });

    expect(await lpNow()).toBe(0);
  });

  it('creates the checkpoints a generous override newly crosses', async () => {
    const order = await creditedOrder(10, 10);

    await overrideOrderLp(db, { orderId: order.id, adminUserId: adminId, newAwardedLp: 300 });

    const events = await db.select().from(levelPassCheckpointEvents).orderBy(levelPassCheckpointEvents.checkpointLp);
    expect(events.map((e) => e.checkpointLp)).toEqual([60, 260]);
    expect(events.every((e) => e.status === 'pending')).toBe(true);
    // Attributed to the admin, not to the sweep.
    expect(events.every((e) => e.source === 'manual')).toBe(true);
  });

  it('revokes a pending checkpoint a reduced override no longer covers', async () => {
    const order = await creditedOrder(100, 100);
    await db.insert(levelPassCheckpointEvents).values({
      seasonId,
      playerProfileId: profileId,
      checkpointLp: 60,
      rewardDiamonds: 110,
      internalCostCents: 1_200,
      status: 'pending',
    });

    await overrideOrderLp(db, { orderId: order.id, adminUserId: adminId, newAwardedLp: 10 });

    const [event] = await db.select().from(levelPassCheckpointEvents);
    expect(event?.status).toBe('reversed');
  });

  it('keeps a granted reward even when the player drops far below it', async () => {
    const order = await creditedOrder(100, 100);
    await db.insert(levelPassCheckpointEvents).values({
      seasonId,
      playerProfileId: profileId,
      checkpointLp: 60,
      rewardDiamonds: 110,
      internalCostCents: 1_200,
      status: 'granted',
      grantedAt: new Date(),
    });

    const result = await overrideOrderLp(db, { orderId: order.id, adminUserId: adminId, newAwardedLp: 0 });

    expect(result.ok && result.plan.checkpointsKept).toEqual([
      expect.objectContaining({ checkpointLp: 60, reason: 'already_granted' }),
    ]);
    const [event] = await db.select().from(levelPassCheckpointEvents);
    expect(event?.status).toBe('granted');
  });

  it('revives a reversed checkpoint rather than inserting a duplicate', async () => {
    const order = await creditedOrder(0, 0);
    await db.insert(levelPassCheckpointEvents).values({
      seasonId,
      playerProfileId: profileId,
      checkpointLp: 60,
      rewardDiamonds: 110,
      internalCostCents: 1_200,
      status: 'reversed',
    });

    await overrideOrderLp(db, { orderId: order.id, adminUserId: adminId, newAwardedLp: 100 });

    const events = await db.select().from(levelPassCheckpointEvents);
    expect(events).toHaveLength(1); // the unique index would have refused a second
    expect(events[0]?.status).toBe('pending');
  });

  it('unlocks the Vault and awards the completion badge when the override finishes the Pass', async () => {
    await db.insert(badgeDefinitions).values({
      badgeKey: 'level_pass_completed',
      title: 'Level Pass completado',
      category: 'level_pass',
      seasonScoped: true,
    });
    const order = await creditedOrder(0, 0);

    await overrideOrderLp(db, { orderId: order.id, adminUserId: adminId, newAwardedLp: 300 });

    const [vault] = await db.select().from(vaultEntitlements);
    expect(vault?.status).toBe('active');
    expect(vault?.expiresAt.toISOString()).toBe(new Date('2026-03-01').toISOString());
    expect(await db.select().from(badgeOwnerships)).toHaveLength(1);
  });

  it('closes the Vault when the override revokes the checkpoint that opened it', async () => {
    const order = await creditedOrder(300, 300);
    await db.insert(levelPassCheckpointEvents).values({
      seasonId,
      playerProfileId: profileId,
      checkpointLp: 260,
      rewardDiamonds: 340,
      internalCostCents: 4_000,
      status: 'pending',
    });
    await db.insert(vaultEntitlements).values({
      seasonId,
      playerProfileId: profileId,
      expiresAt: new Date('2026-03-01'),
    });

    await overrideOrderLp(db, { orderId: order.id, adminUserId: adminId, newAwardedLp: 0 });

    const [vault] = await db.select().from(vaultEntitlements);
    expect(vault?.status).toBe('expired');
  });

  it('records the change with both figures and the admin', async () => {
    const order = await creditedOrder(10, 10);

    await overrideOrderLp(db, {
      orderId: order.id,
      adminUserId: adminId,
      newAwardedLp: 99,
      reason: 'Cortesía',
    });

    const [entry] = await db.select().from(auditLog);
    expect(entry).toMatchObject({ adminUserId: adminId, action: 'order.lp_override', entityId: order.id });
    const detail = entry?.detail as { calculatedLp: number; previousAwardedLp: number; newAwardedLp: number };
    expect(detail.calculatedLp).toBe(10);
    expect(detail.previousAwardedLp).toBe(10);
    expect(detail.newAwardedLp).toBe(99);
  });

  it('is safe to apply twice — the second call works from the new value, not the original', async () => {
    const order = await creditedOrder(10, 10);

    await overrideOrderLp(db, { orderId: order.id, adminUserId: adminId, newAwardedLp: 50 });
    await overrideOrderLp(db, { orderId: order.id, adminUserId: adminId, newAwardedLp: 20 });

    // 10 -> 50 (+40) -> 20 (-30) leaves the season on 20, not 60 or -20.
    expect(await lpNow()).toBe(20);
    const [lpTx] = await db.select().from(levelPassLpTransactions);
    expect(lpTx?.awardedLp).toBe(20);
  });
});
