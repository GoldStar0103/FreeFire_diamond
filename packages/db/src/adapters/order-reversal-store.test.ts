/**
 * Reversing a completed order, against real Postgres.
 *
 * The fixture drives the real `applyDecision` write path first, so each test
 * reverses counters that were genuinely credited rather than hand-written —
 * the whole risk in a reversal is subtracting something different from what
 * was added.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createOrder, syncCatalog } from '@levelup/engine';
import { ProviderSimulator, type ProviderProduct, type UsdTenK } from '@levelup/provider';
import { createDb, type Database } from '../index.js';
import {
  adminUsers,
  auditLog,
  baseProducts,
  campaigns,
  comboItems,
  combos,
  financialLedgerEntries,
  levelPassCheckpointEvents,
  levelPassLpTransactions,
  orderItems,
  orders,
  payments,
  playerProfiles,
  seasonPlayerStats,
  seasons,
  vaultEntitlements,
} from '../schema.js';
import { DrizzleCatalogSyncStore } from './catalog-sync-store.js';
import { DrizzleLevelPassStore } from './level-pass-store.js';
import { DrizzleOrderingStore } from './ordering-store.js';
import { saveFxRate } from './payment-settings.js';
import { reverseCompletedOrder } from './order-reversal-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_order_reversal_test';

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

const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;

async function seedOneCombo() {
  const provider = new ProviderSimulator();
  provider.programCatalog([
    {
      providerProductId: 'd100',
      endpointKind: 'pins_recharge' as const,
      name: 'Free Fire 100 Diamonds',
      sku: 'FF100',
      diamondsBase: 100,
      costUsd: usd(1),
      requiresServerId: false,
      canValidate: true,
      raw: {},
    } satisfies ProviderProduct,
  ]);
  await syncCatalog({ store: new DrizzleCatalogSyncStore(db), provider });

  const [product] = await db.select().from(baseProducts);
  const [campaign] = await db.insert(campaigns).values({ key: 'test', name: 'TEST' }).returning();
  const [combo] = await db
    .insert(combos)
    .values({
      campaignId: campaign!.id,
      key: 'test_combo',
      name: 'Test Combo',
      priceMxnCents: 10_000,
      advertisedDiamonds: 100,
      active: true,
    })
    .returning();
  await db.insert(comboItems).values({ comboId: combo!.id, baseProductId: product!.id, sequence: 0 });
}

let adminId: string;

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(
    raw`TRUNCATE orders, order_items, payments, combo_items, combos, campaigns, base_products,
        player_profiles, seasons, season_player_stats, level_pass_lp_transactions,
        level_pass_checkpoint_events, vault_entitlements, financial_ledger_entries,
        audit_log, admin_users, settings RESTART IDENTITY CASCADE`,
  );
  await seedOneCombo();
  await saveFxRate(db, 20);
  const [admin] = await db
    .insert(adminUsers)
    .values({ email: `admin-${Math.random()}@test.com`, passwordHash: 'x' })
    .returning();
  adminId = admin!.id;
}, 60_000);

async function seedSeason() {
  const [season] = await db
    .insert(seasons)
    .values({ seasonNumber: 1, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-03-01'), status: 'active' })
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

/** A completed, paid order, credited through the real Level Pass write path. */
async function completedCreditedOrder(opts: {
  seasonId: string;
  playerProfileId: string;
  /** The Free Fire ID topped up — differs from the linked one for a secondary. */
  playerId: string;
  awardedLp: number;
}) {
  const result = await createOrder(
    { store: new DrizzleOrderingStore(db) },
    { comboKey: 'test_combo', playerId: opts.playerId, paymentMethod: 'transfer_manual', source: 'admin' },
  );
  if (!result.ok) throw new Error(`seed order failed: ${result.failure.code}`);
  const order = result.order;

  await db
    .update(orders)
    .set({ status: 'completed', completedAt: new Date('2026-02-01'), playerProfileId: opts.playerProfileId })
    .where(eq(orders.id, order.id));
  await db
    .update(orderItems)
    .set({ costUsd: '1.0000', status: 'succeeded' })
    .where(eq(orderItems.orderId, order.id));
  await db.insert(payments).values({
    orderId: order.id,
    method: 'transfer_manual',
    status: 'paid',
    gateway: null,
    amountExpectedCents: 10_000,
    amountReceivedCents: 10_000,
    paidAt: new Date('2026-02-01'),
  });

  await new DrizzleLevelPassStore(db).applyDecision(
    opts.seasonId,
    opts.playerProfileId,
    {
      orderId: order.id,
      playerId: opts.playerId,
      saleAmountCents: 10_000,
      productCostCents: 2_000,
      paymentFeeCents: 0,
      diamonds: 100,
    },
    {
      estimatedProfitCents: 8_000,
      calculatedLp: opts.awardedLp,
      awardedLp: opts.awardedLp,
      newLp: opts.awardedLp,
      newlyCrossedCheckpoints: [],
      vaultUnlocked: false,
    },
  );

  return order;
}

const statsFor = async (seasonId: string, playerProfileId: string) => {
  const [row] = await db
    .select()
    .from(seasonPlayerStats)
    .where(eq(seasonPlayerStats.playerProfileId, playerProfileId));
  expect(row?.seasonId).toBe(seasonId);
  return row!;
};

describe.skipIf(!PG_AVAILABLE)('reverseCompletedOrder', () => {
  it('refuses an order that does not exist', async () => {
    const result = await reverseCompletedOrder(db, {
      orderId: '00000000-0000-0000-0000-000000000000',
      adminUserId: adminId,
      reason: 'test',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses an order that was never completed', async () => {
    const created = await createOrder(
      { store: new DrizzleOrderingStore(db) },
      { comboKey: 'test_combo', playerId: '100001', paymentMethod: 'transfer_manual', source: 'admin' },
    );
    if (!created.ok) throw new Error('seed failed');

    const result = await reverseCompletedOrder(db, {
      orderId: created.order.id,
      adminUserId: adminId,
      reason: 'test',
    });
    expect(result).toEqual({ ok: false, reason: 'not_completed' });
  });

  it('unwinds LP, ranking diamonds and lifetime counters', async () => {
    const season = await seedSeason();
    const profile = await seedProfile('100001');
    const order = await completedCreditedOrder({
      seasonId: season.id,
      playerProfileId: profile.id,
      playerId: '100001',
      awardedLp: 80,
    });

    const before = await statsFor(season.id, profile.id);
    expect(before.lp).toBe(80);
    expect(before.seasonalDiamonds).toBe(100);

    const result = await reverseCompletedOrder(db, {
      orderId: order.id,
      adminUserId: adminId,
      reason: 'Contracargo del banco',
    });

    expect(result.ok).toBe(true);
    const after = await statsFor(season.id, profile.id);
    expect(after.lp).toBe(0);
    expect(after.seasonalDiamonds).toBe(0);

    const [row] = await db.select().from(playerProfiles).where(eq(playerProfiles.id, profile.id));
    expect(row?.lifetimeDiamondsPurchased).toBe(0);
    expect(row?.lifetimeRechargeCount).toBe(0);
  });

  it('moves the order to refunded and shows the customer the reason', async () => {
    const season = await seedSeason();
    const profile = await seedProfile('100001');
    const order = await completedCreditedOrder({
      seasonId: season.id,
      playerProfileId: profile.id,
      playerId: '100001',
      awardedLp: 10,
    });

    await reverseCompletedOrder(db, { orderId: order.id, adminUserId: adminId, reason: 'Pago duplicado' });

    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row?.status).toBe('refunded');
    // Same column the rejection flow uses, so /pedido/[orderNumber] already shows it.
    expect(row?.cancelReason).toBe('Pago duplicado');
  });

  it('leaves the ranking alone when the top-up went to a secondary ID', async () => {
    const season = await seedSeason();
    const profile = await seedProfile('100001');
    // Linked ID is 100001; this order topped up 555555, so it earned LP but no
    // ranking diamonds. The reversal has to be just as asymmetric.
    const order = await completedCreditedOrder({
      seasonId: season.id,
      playerProfileId: profile.id,
      playerId: '555555',
      awardedLp: 50,
    });

    const before = await statsFor(season.id, profile.id);
    expect(before.lp).toBe(50);
    expect(before.seasonalDiamonds).toBe(0);

    await reverseCompletedOrder(db, { orderId: order.id, adminUserId: adminId, reason: 'test' });

    const after = await statsFor(season.id, profile.id);
    expect(after.lp).toBe(0);
    expect(after.seasonalDiamonds).toBe(0); // not -100
  });

  it('posts the refund to the ledger on the day it happens, leaving the sale booked', async () => {
    const season = await seedSeason();
    const profile = await seedProfile('100001');
    const order = await completedCreditedOrder({
      seasonId: season.id,
      playerProfileId: profile.id,
      playerId: '100001',
      awardedLp: 10,
    });

    await reverseCompletedOrder(db, { orderId: order.id, adminUserId: adminId, reason: 'Reembolso' });

    const ledger = await db.select().from(financialLedgerEntries);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      entryType: 'order_refund',
      amountCents: -10_000,
      sourceType: 'order',
      sourceId: order.id,
      seasonId: season.id,
    });
    // The original sale is untouched — its own day's statement does not change.
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row?.priceMxnCents).toBe(10_000);
    expect(row?.completedAt).not.toBeNull();
  });

  it('revokes a pending checkpoint the player can no longer afford', async () => {
    const season = await seedSeason();
    const profile = await seedProfile('100001');
    const order = await completedCreditedOrder({
      seasonId: season.id,
      playerProfileId: profile.id,
      playerId: '100001',
      awardedLp: 80,
    });
    await db.insert(levelPassCheckpointEvents).values({
      seasonId: season.id,
      playerProfileId: profile.id,
      checkpointLp: 60,
      rewardDiamonds: 110,
      internalCostCents: 1_200,
      status: 'pending',
    });

    const result = await reverseCompletedOrder(db, { orderId: order.id, adminUserId: adminId, reason: 'test' });

    expect(result.ok && result.plan?.checkpointEventIdsToReverse).toHaveLength(1);
    const [event] = await db.select().from(levelPassCheckpointEvents);
    expect(event?.status).toBe('reversed');
  });

  it('keeps an already-granted checkpoint and reports it as unrecoverable', async () => {
    const season = await seedSeason();
    const profile = await seedProfile('100001');
    const order = await completedCreditedOrder({
      seasonId: season.id,
      playerProfileId: profile.id,
      playerId: '100001',
      awardedLp: 80,
    });
    await db.insert(levelPassCheckpointEvents).values({
      seasonId: season.id,
      playerProfileId: profile.id,
      checkpointLp: 60,
      rewardDiamonds: 110,
      internalCostCents: 1_200,
      status: 'granted',
      grantedAt: new Date('2026-02-02'),
    });

    const result = await reverseCompletedOrder(db, { orderId: order.id, adminUserId: adminId, reason: 'test' });

    expect(result.ok && result.plan?.checkpointEventIdsToReverse).toEqual([]);
    expect(result.ok && result.plan?.checkpointsKept).toEqual([
      expect.objectContaining({ checkpointLp: 60, reason: 'already_granted' }),
    ]);
    // Those diamonds really went out — the grant and its cost stand.
    const [event] = await db.select().from(levelPassCheckpointEvents);
    expect(event?.status).toBe('granted');
  });

  it('closes the Vault when the checkpoint that unlocked it is revoked', async () => {
    const season = await seedSeason();
    const profile = await seedProfile('100001');
    const order = await completedCreditedOrder({
      seasonId: season.id,
      playerProfileId: profile.id,
      playerId: '100001',
      awardedLp: 80,
    });
    await db.insert(levelPassCheckpointEvents).values({
      seasonId: season.id,
      playerProfileId: profile.id,
      checkpointLp: 60,
      rewardDiamonds: 110,
      internalCostCents: 1_200,
      status: 'pending',
    });
    await db.insert(vaultEntitlements).values({
      seasonId: season.id,
      playerProfileId: profile.id,
      expiresAt: new Date('2026-03-01'),
    });

    await reverseCompletedOrder(db, { orderId: order.id, adminUserId: adminId, reason: 'test' });

    const [vault] = await db.select().from(vaultEntitlements);
    expect(vault?.status).toBe('expired');
  });

  it('marks the LP transaction reversed instead of deleting it, and never re-credits', async () => {
    const season = await seedSeason();
    const profile = await seedProfile('100001');
    const order = await completedCreditedOrder({
      seasonId: season.id,
      playerProfileId: profile.id,
      playerId: '100001',
      awardedLp: 80,
    });

    await reverseCompletedOrder(db, { orderId: order.id, adminUserId: adminId, reason: 'Fraude' });

    const [lpTx] = await db.select().from(levelPassLpTransactions);
    expect(lpTx?.reversedAt).not.toBeNull();
    expect(lpTx?.reversedByAdminId).toBe(adminId);
    expect(lpTx?.reversalReason).toBe('Fraude');
    // Still present, so the sweep's "already processed" check keeps holding.
    expect(await new DrizzleLevelPassStore(db).hasProcessedOrder(order.id)).toBe(true);
  });

  it('is refused the second time, so counters are never unwound twice', async () => {
    const season = await seedSeason();
    const profile = await seedProfile('100001');
    const order = await completedCreditedOrder({
      seasonId: season.id,
      playerProfileId: profile.id,
      playerId: '100001',
      awardedLp: 80,
    });

    expect((await reverseCompletedOrder(db, { orderId: order.id, adminUserId: adminId, reason: 'a' })).ok).toBe(true);
    const second = await reverseCompletedOrder(db, { orderId: order.id, adminUserId: adminId, reason: 'b' });

    expect(second).toEqual({ ok: false, reason: 'not_completed' });
    expect((await statsFor(season.id, profile.id)).lp).toBe(0); // not negative
    expect(await db.select().from(financialLedgerEntries)).toHaveLength(1);
  });

  it('still refunds an order that never earned Level Pass progress', async () => {
    // A guest order, or one completed before any season existed.
    const created = await createOrder(
      { store: new DrizzleOrderingStore(db) },
      { comboKey: 'test_combo', playerId: '100001', paymentMethod: 'transfer_manual', source: 'admin' },
    );
    if (!created.ok) throw new Error('seed failed');
    await db
      .update(orders)
      .set({ status: 'completed', completedAt: new Date('2026-02-01') })
      .where(eq(orders.id, created.order.id));

    const result = await reverseCompletedOrder(db, {
      orderId: created.order.id,
      adminUserId: adminId,
      reason: 'test',
    });

    expect(result).toMatchObject({ ok: true, plan: null, refundedCents: 10_000 });
    expect(await db.select().from(financialLedgerEntries)).toHaveLength(1);
  });

  it('records who did it and why', async () => {
    const season = await seedSeason();
    const profile = await seedProfile('100001');
    const order = await completedCreditedOrder({
      seasonId: season.id,
      playerProfileId: profile.id,
      playerId: '100001',
      awardedLp: 10,
    });

    await reverseCompletedOrder(db, { orderId: order.id, adminUserId: adminId, reason: 'Contracargo' });

    const [entry] = await db.select().from(auditLog);
    expect(entry).toMatchObject({
      adminUserId: adminId,
      action: 'order.reverse',
      entityType: 'order',
      entityId: order.id,
    });
    expect((entry?.detail as { reason: string }).reason).toBe('Contracargo');
  });
});
