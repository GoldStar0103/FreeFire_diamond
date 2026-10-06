/**
 * `DrizzleLevelPassStore` against real Postgres.
 *
 * Orders come from the real `createOrder` engine call, then are patched
 * straight to a completed+paid state with concrete figures — the same
 * pragmatic style `accounting-queries.test.ts` uses, since running full
 * provider fulfilment just to get a `completed` order would test the
 * fulfilment engine again, not this store.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createOrder } from '@levelup/engine';
import { ProviderSimulator, type ProviderProduct, type UsdTenK } from '@levelup/provider';
import { createDb, type Database } from '../index.js';
import { LEVEL_PASS_REWARD_COMBO_KEY } from '@levelup/engine';
import {
  badgeDefinitions,
  campaigns,
  comboItems,
  combos,
  baseProducts,
  financialLedgerEntries,
  orderItems,
  orders,
  payments,
  playerProfiles,
  seasonPlayerStats,
  seasons,
  vaultEntitlements,
  levelPassCheckpointEvents,
  levelPassLpTransactions,
  badgeOwnerships,
} from '../schema.js';
import { DrizzleCatalogSyncStore } from './catalog-sync-store.js';
import { DrizzleOrderingStore } from './ordering-store.js';
import { saveFxRate } from './payment-settings.js';
import { saveLevelPassCheckpoints, DEFAULT_LEVEL_PASS_CHECKPOINTS } from './level-pass-settings.js';
import { syncCatalog } from '@levelup/engine';
import { DrizzleLevelPassStore } from './level-pass-store.js';
import type { LevelPassDecision } from '@levelup/engine';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_level_pass_test';

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

async function placeOrder(playerId: string) {
  const result = await createOrder(
    { store: new DrizzleOrderingStore(db) },
    { comboKey: 'test_combo', playerId, paymentMethod: 'transfer_manual', source: 'admin' },
  );
  if (!result.ok) throw new Error(`seed order failed: ${result.failure.code}`);
  return result.order;
}

/** Completed + paid + delivered, with concrete cost/payment figures for exact-cents assertions. */
async function completeOrder(
  orderId: string,
  opts: {
    completedAt: Date;
    costUsd: string;
    method: 'card' | 'transfer_manual' | 'spei' | 'oxxo';
    gateway: string | null;
    amountReceivedCents: number;
  },
) {
  await db
    .update(orders)
    .set({ status: 'completed', completedAt: opts.completedAt, createdAt: opts.completedAt })
    .where(eq(orders.id, orderId));
  await db
    .update(orderItems)
    .set({ costUsd: opts.costUsd, status: 'succeeded' })
    .where(eq(orderItems.orderId, orderId));
  await db.insert(payments).values({
    orderId,
    method: opts.method,
    status: 'paid',
    gateway: opts.gateway,
    amountExpectedCents: opts.amountReceivedCents,
    amountReceivedCents: opts.amountReceivedCents,
    paidAt: opts.completedAt,
  });
}

async function seedProfile(playerId: string, displayName: string | null = null) {
  const [profile] = await db
    .insert(playerProfiles)
    .values({ playerId, whatsapp: `+52${playerId}`, displayName })
    .returning();
  return profile!;
}

async function seedActiveSeason(seasonNumber = 1) {
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

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(
    raw`TRUNCATE orders, order_items, payments, combo_items, combos, campaigns, base_products,
        player_profiles, seasons, season_player_stats, level_pass_lp_transactions,
        level_pass_checkpoint_events, vault_entitlements, badge_definitions, badge_ownerships,
        settings
        RESTART IDENTITY CASCADE`,
  );
  await seedOneCombo();
  await saveFxRate(db, 20); // round number for exact-cents assertions
});

describe('findActiveSeason', () => {
  it('returns null when there is no active season', async () => {
    const store = new DrizzleLevelPassStore(db);
    expect(await store.findActiveSeason()).toBeNull();
  });

  it('returns the active season, ignoring a closed one', async () => {
    await db.insert(seasons).values({
      seasonNumber: 1,
      startsAt: new Date('2025-01-01'),
      endsAt: new Date('2025-03-01'),
      status: 'closed',
      closedAt: new Date('2025-03-01'),
    });
    const active = await seedActiveSeason(2);

    const store = new DrizzleLevelPassStore(db);
    const found = await store.findActiveSeason();
    expect(found?.id).toBe(active.id);
  });
});

describe('getPlayerState', () => {
  it('returns null for a Free Fire ID with no linked account', async () => {
    const season = await seedActiveSeason();
    const store = new DrizzleLevelPassStore(db);
    expect(await store.getPlayerState(season.id, '100999')).toBeNull();
  });

  it('starts a linked player at zero LP with no reached checkpoints', async () => {
    const season = await seedActiveSeason();
    const profile = await seedProfile('100001');
    const store = new DrizzleLevelPassStore(db);

    const state = await store.getPlayerState(season.id, '100001');
    expect(state).toEqual({
      seasonId: season.id,
      playerProfileId: profile.id,
      currentLp: 0,
      reachedCheckpoints: [],
    });
  });

  it('reflects existing season stats and reached checkpoints', async () => {
    const season = await seedActiveSeason();
    const profile = await seedProfile('100001');
    await db.insert(seasonPlayerStats).values({ seasonId: season.id, playerProfileId: profile.id, lp: 300, seasonalDiamonds: 500 });
    await db.insert(levelPassCheckpointEvents).values([
      { seasonId: season.id, playerProfileId: profile.id, checkpointLp: 60, rewardDiamonds: 110, internalCostCents: 1_200, status: 'pending' },
      { seasonId: season.id, playerProfileId: profile.id, checkpointLp: 260, rewardDiamonds: 340, internalCostCents: 4_000, status: 'pending' },
    ]);

    const store = new DrizzleLevelPassStore(db);
    const state = await store.getPlayerState(season.id, '100001');
    expect(state?.currentLp).toBe(300);
    expect(state?.reachedCheckpoints.sort((a, b) => a - b)).toEqual([60, 260]);
  });
});

describe('getCheckpointConfig', () => {
  it('returns the default ladder when nothing has been configured', async () => {
    const store = new DrizzleLevelPassStore(db);
    expect(await store.getCheckpointConfig()).toEqual(DEFAULT_LEVEL_PASS_CHECKPOINTS);
  });

  it('returns a saved custom ladder', async () => {
    // `seedOneCombo` (in `beforeEach`) already synced an active `d100` product.
    await saveLevelPassCheckpoints(db, [{ lp: 100, rewardDiamonds: 50, costCents: 500, recipe: [100] }]);
    const store = new DrizzleLevelPassStore(db);
    const [saved] = await store.getCheckpointConfig();
    expect(saved).toMatchObject({ lp: 100, rewardDiamonds: 50, costCents: 500 });
    expect(saved?.recipe).toHaveLength(1);
    expect(saved?.recipe[0]?.diamondsBase).toBe(100);
  });
});

describe('hasProcessedOrder', () => {
  it('is false for an order with no transaction row, true once one exists', async () => {
    const season = await seedActiveSeason();
    const profile = await seedProfile('100001');
    const order = await placeOrder('100001');
    const store = new DrizzleLevelPassStore(db);

    expect(await store.hasProcessedOrder(order.id)).toBe(false);

    await store.applyDecision(
      season.id,
      profile.id,
      { orderId: order.id, playerId: '100001', saleAmountCents: 1_000, productCostCents: 500, paymentFeeCents: 0, diamonds: 100 },
      { estimatedProfitCents: 500, calculatedLp: 5, awardedLp: 5, newLp: 5, newlyCrossedCheckpoints: [], vaultUnlocked: false },
    );

    expect(await store.hasProcessedOrder(order.id)).toBe(true);
  });
});

const decision = (overrides: Partial<LevelPassDecision> = {}): LevelPassDecision => ({
  estimatedProfitCents: 500,
  calculatedLp: 5,
  awardedLp: 5,
  newLp: 5,
  newlyCrossedCheckpoints: [],
  vaultUnlocked: false,
  ...overrides,
});

describe('applyDecision', () => {
  it('records the LP transaction with the exact financial figures given', async () => {
    const season = await seedActiveSeason();
    const profile = await seedProfile('100001');
    const order = await placeOrder('100001');
    const store = new DrizzleLevelPassStore(db);

    await store.applyDecision(
      season.id,
      profile.id,
      { orderId: order.id, playerId: '100001', saleAmountCents: 1_800, productCostCents: 1_200, paymentFeeCents: 423, diamonds: 100 },
      decision({ estimatedProfitCents: 175, calculatedLp: 2, awardedLp: 2, newLp: 2 }),
    );

    const [tx] = await db.select().from(levelPassLpTransactions);
    expect(tx).toMatchObject({
      orderId: order.id,
      seasonId: season.id,
      playerProfileId: profile.id,
      saleAmountCents: 1_800,
      productCostCents: 1_200,
      paymentFeeCents: 423,
      estimatedProfitCents: 175,
      calculatedLp: 2,
      awardedLp: 2,
    });
  });

  it('upserts season_player_stats, accumulating across two orders', async () => {
    const season = await seedActiveSeason();
    const profile = await seedProfile('100001');
    const orderA = await placeOrder('100001');
    const orderB = await placeOrder('100001');
    const store = new DrizzleLevelPassStore(db);

    await store.applyDecision(
      season.id, profile.id,
      { orderId: orderA.id, playerId: '100001', saleAmountCents: 1_800, productCostCents: 1_200, paymentFeeCents: 0, diamonds: 100 },
      decision({ awardedLp: 6, newLp: 6 }),
    );
    await store.applyDecision(
      season.id, profile.id,
      { orderId: orderB.id, playerId: '100001', saleAmountCents: 1_800, productCostCents: 1_200, paymentFeeCents: 0, diamonds: 100 },
      decision({ awardedLp: 6, newLp: 12 }),
    );

    const [stats] = await db.select().from(seasonPlayerStats).where(eq(seasonPlayerStats.playerProfileId, profile.id));
    expect(stats).toMatchObject({ lp: 12, seasonalDiamonds: 200 });
  });

  it('increments the player profile lifetime counters', async () => {
    const season = await seedActiveSeason();
    const profile = await seedProfile('100001');
    const order = await placeOrder('100001');
    const store = new DrizzleLevelPassStore(db);

    await store.applyDecision(
      season.id, profile.id,
      { orderId: order.id, playerId: '100001', saleAmountCents: 1_800, productCostCents: 1_200, paymentFeeCents: 0, diamonds: 100 },
      decision(),
    );

    const [row] = await db.select().from(playerProfiles).where(eq(playerProfiles.id, profile.id));
    expect(row).toMatchObject({ lifetimeDiamondsPurchased: 100, lifetimeRechargeCount: 1 });
  });

  it('records one checkpoint event per newly crossed checkpoint, status pending', async () => {
    const season = await seedActiveSeason();
    const profile = await seedProfile('100001');
    const order = await placeOrder('100001');
    const store = new DrizzleLevelPassStore(db);

    await store.applyDecision(
      season.id, profile.id,
      { orderId: order.id, playerId: '100001', saleAmountCents: 100_000, productCostCents: 1_200, paymentFeeCents: 0, diamonds: 100 },
      decision({
        newlyCrossedCheckpoints: [
          { checkpointLp: 60, rewardDiamonds: 110, costCents: 1_200 },
          { checkpointLp: 260, rewardDiamonds: 340, costCents: 4_000 },
        ],
      }),
    );

    const rows = await db.select().from(levelPassCheckpointEvents).where(eq(levelPassCheckpointEvents.playerProfileId, profile.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'pending' && r.source === 'automatic' && r.relatedOrderId === order.id)).toBe(true);
    expect(rows.map((r) => r.checkpointLp).sort((a, b) => a - b)).toEqual([60, 260]);
  });

  it('does not create a Vault entitlement or badge when the Vault is not unlocked', async () => {
    const season = await seedActiveSeason();
    const profile = await seedProfile('100001');
    const order = await placeOrder('100001');
    const store = new DrizzleLevelPassStore(db);

    await store.applyDecision(
      season.id, profile.id,
      { orderId: order.id, playerId: '100001', saleAmountCents: 1_800, productCostCents: 1_200, paymentFeeCents: 0, diamonds: 100 },
      decision({ vaultUnlocked: false }),
    );

    expect(await db.select().from(vaultEntitlements)).toHaveLength(0);
    expect(await db.select().from(badgeOwnerships)).toHaveLength(0);
  });

  it('unlocks the Vault through the season end date and awards the Level Pass Completed badge when it is defined', async () => {
    const season = await seedActiveSeason();
    const profile = await seedProfile('100001');
    const order = await placeOrder('100001');
    const [badge] = await db
      .insert(badgeDefinitions)
      .values({ badgeKey: 'level_pass_completed', title: 'Level Pass Completed', category: 'level_pass', seasonScoped: true })
      .returning();
    const store = new DrizzleLevelPassStore(db);

    await store.applyDecision(
      season.id, profile.id,
      { orderId: order.id, playerId: '100001', saleAmountCents: 1_800, productCostCents: 1_200, paymentFeeCents: 0, diamonds: 100 },
      decision({ vaultUnlocked: true }),
    );

    const [entitlement] = await db.select().from(vaultEntitlements);
    expect(entitlement).toMatchObject({ seasonId: season.id, playerProfileId: profile.id, status: 'active', expiresAt: season.endsAt });

    const [ownership] = await db.select().from(badgeOwnerships);
    expect(ownership).toMatchObject({ playerProfileId: profile.id, badgeDefinitionId: badge!.id, seasonId: season.id, source: 'automatic' });
  });

  it('skips the badge award gracefully when "level_pass_completed" is not yet defined', async () => {
    const season = await seedActiveSeason();
    const profile = await seedProfile('100001');
    const order = await placeOrder('100001');
    const store = new DrizzleLevelPassStore(db);

    await expect(
      store.applyDecision(
        season.id, profile.id,
        { orderId: order.id, playerId: '100001', saleAmountCents: 1_800, productCostCents: 1_200, paymentFeeCents: 0, diamonds: 100 },
        decision({ vaultUnlocked: true }),
      ),
    ).resolves.not.toThrow();

    expect(await db.select().from(vaultEntitlements)).toHaveLength(1); // the entitlement still happens
    expect(await db.select().from(badgeOwnerships)).toHaveLength(0); // just no badge
  });

  it('is idempotent: a second call for the same order changes nothing further', async () => {
    const season = await seedActiveSeason();
    const profile = await seedProfile('100001');
    const order = await placeOrder('100001');
    const store = new DrizzleLevelPassStore(db);
    const input = {
      orderId: order.id, playerId: '100001', saleAmountCents: 1_800, productCostCents: 1_200, paymentFeeCents: 0, diamonds: 100,
    };

    await store.applyDecision(season.id, profile.id, input, decision({ awardedLp: 6, newLp: 6 }));
    // Simulates a race where the caller's own hasProcessedOrder check already passed twice.
    await store.applyDecision(season.id, profile.id, input, decision({ awardedLp: 6, newLp: 12 }));

    const [stats] = await db.select().from(seasonPlayerStats).where(eq(seasonPlayerStats.playerProfileId, profile.id));
    expect(stats?.lp).toBe(6); // not 12 — the second call's write was refused
    const [row] = await db.select().from(playerProfiles).where(eq(playerProfiles.id, profile.id));
    expect(row?.lifetimeRechargeCount).toBe(1); // not 2
  });
});

describe('findUnprocessedOrders', () => {
  it('returns a completed order with its computed financials, and excludes an already-processed one', async () => {
    const season = await seedActiveSeason();
    await seedProfile('100001');
    await seedProfile('100002');

    const orderA = await placeOrder('100001'); // will be processed already
    const orderB = await placeOrder('100002'); // pending

    const completedAt = new Date('2026-02-01T00:00:00Z');
    await completeOrder(orderA.id, { completedAt, costUsd: '1.0000', method: 'transfer_manual', gateway: null, amountReceivedCents: 10_000 });
    await completeOrder(orderB.id, { completedAt, costUsd: '1.0000', method: 'oxxo', gateway: 'mercadopago', amountReceivedCents: 10_000 });

    const store = new DrizzleLevelPassStore(db);
    await store.applyDecision(
      season.id, (await db.select().from(playerProfiles).where(eq(playerProfiles.playerId, '100001')))[0]!.id,
      { orderId: orderA.id, playerId: '100001', saleAmountCents: 10_000, productCostCents: 2_000, paymentFeeCents: 0, diamonds: 100 },
      decision(),
    );

    const pending = await store.findUnprocessedOrders({ completedAfter: new Date('2026-01-01'), limit: 10 });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      orderId: orderB.id,
      playerId: '100002',
      saleAmountCents: 10_000,
      productCostCents: 2_000, // $1.00 USD * 20 fx = $20 MXN = 2,000 cents
      diamonds: 100,
    });
    // oxxo via mercadopago: 3.49% + $4.00, *1.16 IVA — matches accounting-queries.ts's own table.
    expect(pending[0]!.paymentFeeCents).toBe(Math.round((10_000 * 0.0349 + 400) * 1.16));
  });

  it('excludes an order completed before the lookback window', async () => {
    await seedProfile('100001');
    const order = await placeOrder('100001');
    await completeOrder(order.id, { completedAt: new Date('2020-01-01'), costUsd: '1.0000', method: 'transfer_manual', gateway: null, amountReceivedCents: 10_000 });

    const store = new DrizzleLevelPassStore(db);
    const pending = await store.findUnprocessedOrders({ completedAfter: new Date('2026-01-01'), limit: 10 });
    expect(pending).toEqual([]);
  });

  it('only counts succeeded items toward diamonds', async () => {
    await seedProfile('100001');
    const order = await placeOrder('100001');
    await completeOrder(order.id, { completedAt: new Date('2026-02-01'), costUsd: '1.0000', method: 'transfer_manual', gateway: null, amountReceivedCents: 10_000 });
    await db.update(orderItems).set({ status: 'failed' }).where(eq(orderItems.orderId, order.id));

    const store = new DrizzleLevelPassStore(db);
    const pending = await store.findUnprocessedOrders({ completedAfter: new Date('2026-01-01'), limit: 10 });
    expect(pending[0]?.diamonds).toBe(0);
  });

  it('excludes a completed Level Pass reward order — it must never generate recursive LP', async () => {
    await seedProfile('100001');
    await db.insert(orders).values({
      orderNumber: 'LU-REWARD-1',
      playerId: '100001',
      comboId: null,
      comboKey: LEVEL_PASS_REWARD_COMBO_KEY,
      comboSnapshot: { name: 'Recompensa Level Pass' },
      priceMxnCents: 0,
      status: 'completed',
      completedAt: new Date('2026-02-01'),
    });

    const store = new DrizzleLevelPassStore(db);
    const pending = await store.findUnprocessedOrders({ completedAfter: new Date('2026-01-01'), limit: 10 });
    expect(pending).toEqual([]);
  });
});

describe('reward delivery', () => {
  async function seedCheckpointEvent(
    seasonId: string,
    playerProfileId: string,
    overrides: Partial<{ checkpointLp: number; rewardDiamonds: number; internalCostCents: number; status: 'pending' | 'granted' | 'reversed'; rewardOrderId: string | null }> = {},
  ) {
    const [row] = await db
      .insert(levelPassCheckpointEvents)
      .values({
        seasonId,
        playerProfileId,
        checkpointLp: 60,
        rewardDiamonds: 110,
        internalCostCents: 1_200,
        status: 'pending',
        ...overrides,
      })
      .returning();
    return row!;
  }

  describe('findGrantableCheckpointEvents', () => {
    it('returns a pending event with no reward order yet, with its recipe from the current config', async () => {
      const season = await seedActiveSeason();
      const profile = await seedProfile('100001');
      const event = await seedCheckpointEvent(season.id, profile.id);
      await saveLevelPassCheckpoints(db, [
        { lp: 60, rewardDiamonds: 110, costCents: 1_200, recipe: [100] },
      ]);

      const store = new DrizzleLevelPassStore(db);
      const grantable = await store.findGrantableCheckpointEvents(10);

      expect(grantable).toHaveLength(1);
      expect(grantable[0]).toMatchObject({
        checkpointEventId: event.id,
        seasonId: season.id,
        playerId: '100001',
        checkpointLp: 60,
        rewardDiamonds: 110,
      });
      expect(grantable[0]?.recipe).toHaveLength(1);
      expect(grantable[0]?.recipe[0]?.diamondsBase).toBe(100);
    });

    it('excludes an event that already has a reward order', async () => {
      const season = await seedActiveSeason();
      const profile = await seedProfile('100001');
      const order = await placeOrder('100001');
      await seedCheckpointEvent(season.id, profile.id, { rewardOrderId: order.id });

      const store = new DrizzleLevelPassStore(db);
      expect(await store.findGrantableCheckpointEvents(10)).toEqual([]);
    });

    it('excludes an already-granted event', async () => {
      const season = await seedActiveSeason();
      const profile = await seedProfile('100001');
      await seedCheckpointEvent(season.id, profile.id, { status: 'granted' });

      const store = new DrizzleLevelPassStore(db);
      expect(await store.findGrantableCheckpointEvents(10)).toEqual([]);
    });

    it('returns an empty recipe when the checkpoint has since been removed from the config', async () => {
      const season = await seedActiveSeason();
      const profile = await seedProfile('100001');
      await seedCheckpointEvent(season.id, profile.id, { checkpointLp: 999 });
      await saveLevelPassCheckpoints(db, [{ lp: 60, rewardDiamonds: 110, costCents: 1_200, recipe: [100] }]);

      const store = new DrizzleLevelPassStore(db);
      const grantable = await store.findGrantableCheckpointEvents(10);
      expect(grantable[0]?.recipe).toEqual([]);
    });
  });

  describe('resolveRewardCatalog', () => {
    it('resolves a live base_products row by id', async () => {
      const [product] = await db.select().from(baseProducts);
      const store = new DrizzleLevelPassStore(db);
      const resolved = await store.resolveRewardCatalog([product!.id]);

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        baseProductId: product!.id,
        providerProductId: 'd100',
        diamondsBase: 100,
        active: true,
      });
      expect(resolved[0]?.costUsd).toBe(10_000); // $1.00 USD, in ten-thousandths
    });

    it('returns an empty list for an empty input rather than querying', async () => {
      const store = new DrizzleLevelPassStore(db);
      expect(await store.resolveRewardCatalog([])).toEqual([]);
    });
  });

  describe('createRewardOrder', () => {
    it('creates a $0 order already payment_confirmed, with no paidAt, and links it onto the checkpoint event', async () => {
      const season = await seedActiveSeason();
      const profile = await seedProfile('100001');
      const event = await seedCheckpointEvent(season.id, profile.id);
      const [product] = await db.select().from(baseProducts);

      const store = new DrizzleLevelPassStore(db);
      const result = await store.createRewardOrder(
        { checkpointEventId: event.id, seasonId: season.id, playerId: '100001', checkpointLp: 60, rewardDiamonds: 110, recipe: [] },
        [{ sequence: 0, baseProductId: product!.id, providerProductId: 'd100', endpointKind: 'pins_recharge', diamondsBase: 100, costUsd: 10_000 as never }],
      );

      expect(result.created).toBe(true);
      const [order] = await db.select().from(orders).where(eq(orders.id, result.orderId));
      expect(order).toMatchObject({ comboKey: LEVEL_PASS_REWARD_COMBO_KEY, comboId: null, priceMxnCents: 0, status: 'payment_confirmed' });
      expect(order?.paidAt).toBeNull();

      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, result.orderId));
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ providerProductId: 'd100', diamondsBase: 100, status: 'queued' });

      const [linked] = await db.select().from(levelPassCheckpointEvents).where(eq(levelPassCheckpointEvents.id, event.id));
      expect(linked?.rewardOrderId).toBe(result.orderId);
    });

    it('refuses a second reward order for the same checkpoint event, rolling back the attempt', async () => {
      const season = await seedActiveSeason();
      const profile = await seedProfile('100001');
      const event = await seedCheckpointEvent(season.id, profile.id);
      const [product] = await db.select().from(baseProducts);
      const items = [{ sequence: 0, baseProductId: product!.id, providerProductId: 'd100', endpointKind: 'pins_recharge' as const, diamondsBase: 100, costUsd: 10_000 as never }];
      const rewardInput = { checkpointEventId: event.id, seasonId: season.id, playerId: '100001', checkpointLp: 60, rewardDiamonds: 110, recipe: [] };

      const store = new DrizzleLevelPassStore(db);
      await store.createRewardOrder(rewardInput, items);

      await expect(store.createRewardOrder(rewardInput, items)).rejects.toThrow(/already has a reward order/);

      // Only the first order exists — the second attempt's insert was rolled back.
      const allOrders = await db.select().from(orders);
      expect(allOrders).toHaveLength(1);
    });
  });

  describe('findCompletedRewardOrders / grantReward', () => {
    it('finds a pending event whose reward order has completed, then grants it exactly once', async () => {
      const season = await seedActiveSeason();
      const profile = await seedProfile('100001');
      const event = await seedCheckpointEvent(season.id, profile.id, { internalCostCents: 1_200 });
      const [product] = await db.select().from(baseProducts);

      const store = new DrizzleLevelPassStore(db);
      const { orderId } = await store.createRewardOrder(
        { checkpointEventId: event.id, seasonId: season.id, playerId: '100001', checkpointLp: 60, rewardDiamonds: 110, recipe: [] },
        [{ sequence: 0, baseProductId: product!.id, providerProductId: 'd100', endpointKind: 'pins_recharge', diamondsBase: 100, costUsd: 10_000 as never }],
      );

      // Not yet completed — nothing to grant.
      expect(await store.findCompletedRewardOrders(10)).toEqual([]);

      await db.update(orders).set({ status: 'completed', completedAt: new Date() }).where(eq(orders.id, orderId));

      const completed = await store.findCompletedRewardOrders(10);
      expect(completed).toEqual([{ checkpointEventId: event.id, seasonId: season.id, rewardOrderId: orderId, internalCostCents: 1_200 }]);

      await store.grantReward(completed[0]!);

      const [granted] = await db.select().from(levelPassCheckpointEvents).where(eq(levelPassCheckpointEvents.id, event.id));
      expect(granted?.status).toBe('granted');
      expect(granted?.grantedAt).not.toBeNull();

      const ledger = await db.select().from(financialLedgerEntries);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        entryType: 'level_pass_reward',
        amountCents: -1_200,
        seasonId: season.id,
        sourceType: 'level_pass_checkpoint_event',
        sourceId: event.id,
      });

      // A granted event no longer shows up as completed-but-ungranted, and a
      // second grant call must not record the expense twice.
      expect(await store.findCompletedRewardOrders(10)).toEqual([]);
      await store.grantReward(completed[0]!);
      expect(await db.select().from(financialLedgerEntries)).toHaveLength(1);
    });
  });
});
