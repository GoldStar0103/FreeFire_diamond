import { describe, expect, it, vi } from 'vitest';
import {
  createPendingRewardOrders,
  decideLevelPassOutcome,
  grantCompletedRewardOrders,
  processOrderCompletion,
  syncLevelPass,
  type GrantableRewardOrder,
  type LevelPassCheckpointConfig,
  type LevelPassCurrentState,
  type LevelPassOrderFinancials,
  type LevelPassStore,
  type LevelPassSweepStore,
  type PendingCheckpointReward,
  type ResolvedRewardCatalogEntry,
  type RewardFulfillmentStore,
} from './level-pass.js';
import type { UsdTenK } from '@levelup/provider';

const CHECKPOINTS: LevelPassCheckpointConfig[] = [
  { lp: 60, rewardDiamonds: 110, costCents: 1_200, recipe: [{ baseProductId: 'bp-110', diamondsBase: 110 }] },
  { lp: 260, rewardDiamonds: 340, costCents: 4_000, recipe: [{ baseProductId: 'bp-340', diamondsBase: 340 }] },
  { lp: 585, rewardDiamonds: 570, costCents: 6_500, recipe: [{ baseProductId: 'bp-570', diamondsBase: 570 }] },
  { lp: 1_185, rewardDiamonds: 1_160, costCents: 12_000, recipe: [{ baseProductId: 'bp-1160', diamondsBase: 1_160 }] },
];

const state = (overrides: Partial<LevelPassCurrentState> = {}): LevelPassCurrentState => ({
  seasonId: 'season-1',
  playerProfileId: 'profile-1',
  currentLp: 0,
  reachedCheckpoints: [],
  ...overrides,
});

const order = (overrides: Partial<LevelPassOrderFinancials> = {}): LevelPassOrderFinancials => ({
  orderId: 'order-1',
  playerId: 'ff-123',
  saleAmountCents: 1_800,
  productCostCents: 1_200,
  paymentFeeCents: 423,
  diamonds: 110,
  ...overrides,
});

describe('decideLevelPassOutcome', () => {
  it('calculates profit and rounds it to LP', () => {
    const d = decideLevelPassOutcome(state(), order(), CHECKPOINTS);
    expect(d.estimatedProfitCents).toBe(1_800 - 1_200 - 423);
    expect(d.calculatedLp).toBe(Math.round(175 / 100));
    expect(d.awardedLp).toBe(d.calculatedLp);
    expect(d.newLp).toBe(d.calculatedLp);
  });

  it('clamps a loss-making order to zero LP instead of going negative', () => {
    const d = decideLevelPassOutcome(
      state(),
      order({ saleAmountCents: 1_000, productCostCents: 1_200, paymentFeeCents: 100 }),
      CHECKPOINTS,
    );
    expect(d.estimatedProfitCents).toBe(-300);
    expect(d.calculatedLp).toBe(0);
    expect(d.awardedLp).toBe(0);
  });

  it.each<[import('./level-pass.js').LpRoundingRule, number]>([
    ['round', 13],
    ['floor', 12],
    ['ceil', 13],
  ])('applies the %s rounding rule', (rule, expected) => {
    const d = decideLevelPassOutcome(
      state(),
      order({ saleAmountCents: 2_000, productCostCents: 703, paymentFeeCents: 0 }), // $12.97 profit
      CHECKPOINTS,
      rule,
    );
    expect(d.calculatedLp).toBe(expected);
  });

  it('uses the manual override instead of the calculated value, but keeps the calculated value visible', () => {
    const d = decideLevelPassOutcome(
      state(),
      order({ manualLpOverride: { lp: 999, adminId: 'admin-1', reason: 'promo' } }),
      CHECKPOINTS,
    );
    expect(d.calculatedLp).toBe(2); // the real number, preserved for the audit trail
    expect(d.awardedLp).toBe(999);
    expect(d.newLp).toBe(999);
  });

  it('crosses exactly the one checkpoint a modest order reaches', () => {
    const d = decideLevelPassOutcome(
      state({ currentLp: 0 }),
      order({ manualLpOverride: { lp: 60, adminId: 'x' } }),
      CHECKPOINTS,
    );
    expect(d.newlyCrossedCheckpoints).toEqual([{ checkpointLp: 60, rewardDiamonds: 110, costCents: 1_200 }]);
    expect(d.vaultUnlocked).toBe(false);
  });

  it('crosses every checkpoint a huge single order jumps past at once', () => {
    const d = decideLevelPassOutcome(
      state({ currentLp: 0 }),
      order({ manualLpOverride: { lp: 1_185, adminId: 'x' } }),
      CHECKPOINTS,
    );
    expect(d.newlyCrossedCheckpoints.map((g) => g.checkpointLp)).toEqual([60, 260, 585, 1_185]);
    expect(d.vaultUnlocked).toBe(true);
  });

  it('does not re-grant a checkpoint already reached this season', () => {
    const d = decideLevelPassOutcome(
      state({ currentLp: 260, reachedCheckpoints: [60, 260] }),
      order({ manualLpOverride: { lp: 50, adminId: 'x' } }), // lands at 310, still below 585
      CHECKPOINTS,
    );
    expect(d.newlyCrossedCheckpoints).toEqual([]);
  });

  it('is unaffected by checkpoint config arriving out of order', () => {
    const shuffled = [CHECKPOINTS[2]!, CHECKPOINTS[0]!, CHECKPOINTS[3]!, CHECKPOINTS[1]!];
    const d = decideLevelPassOutcome(
      state(),
      order({ manualLpOverride: { lp: 300, adminId: 'x' } }),
      shuffled,
    );
    expect(d.newlyCrossedCheckpoints.map((g) => g.checkpointLp)).toEqual([60, 260]);
  });

  it('only unlocks the Vault on the highest configured checkpoint, not an intermediate one', () => {
    const d = decideLevelPassOutcome(
      state({ currentLp: 500, reachedCheckpoints: [60, 260] }),
      order({ manualLpOverride: { lp: 85, adminId: 'x' } }), // lands at 585
      CHECKPOINTS,
    );
    expect(d.newlyCrossedCheckpoints.map((g) => g.checkpointLp)).toEqual([585]);
    expect(d.vaultUnlocked).toBe(false);
  });
});

function harness(overrides: Partial<LevelPassStore> = {}) {
  const store: LevelPassStore = {
    hasProcessedOrder: vi.fn(async () => false),
    findActiveSeason: vi.fn(async () => ({ id: 'season-1', endsAt: new Date('2026-12-01') })),
    getPlayerState: vi.fn(async () => state()),
    getCheckpointConfig: vi.fn(async () => CHECKPOINTS),
    applyDecision: vi.fn(async () => undefined),
    ...overrides,
  };
  return { store };
}

describe('processOrderCompletion', () => {
  it('skips an already-processed order without touching the season or player lookups', async () => {
    const { store } = harness({ hasProcessedOrder: vi.fn(async () => true) });
    const result = await processOrderCompletion({ store }, order());

    expect(result).toEqual({ status: 'already_processed' });
    expect(store.findActiveSeason).not.toHaveBeenCalled();
    expect(store.applyDecision).not.toHaveBeenCalled();
  });

  it('does nothing when there is no active season', async () => {
    const { store } = harness({ findActiveSeason: vi.fn(async () => null) });
    const result = await processOrderCompletion({ store }, order());

    expect(result).toEqual({ status: 'no_active_season' });
    expect(store.getPlayerState).not.toHaveBeenCalled();
  });

  it('does nothing when the Free Fire ID has no linked account', async () => {
    const { store } = harness({ getPlayerState: vi.fn(async () => null) });
    const result = await processOrderCompletion({ store }, order());

    expect(result).toEqual({ status: 'no_linked_account' });
    expect(store.applyDecision).not.toHaveBeenCalled();
  });

  it('applies the decision and returns it on success', async () => {
    const { store } = harness();
    const result = await processOrderCompletion({ store }, order());

    expect(result.status).toBe('applied');
    expect(store.applyDecision).toHaveBeenCalledTimes(1);
    expect(store.applyDecision).toHaveBeenCalledWith(
      'season-1',
      'profile-1',
      expect.objectContaining({ orderId: 'order-1' }),
      expect.objectContaining({ calculatedLp: expect.any(Number) }),
    );
  });

  it('threads the configured rounding rule through to the decision', async () => {
    const { store } = harness({
      getPlayerState: vi.fn(async () => state()),
    });
    const result = await processOrderCompletion(
      { store, roundingRule: 'floor' },
      order({ saleAmountCents: 2_000, productCostCents: 703, paymentFeeCents: 0 }),
    );
    expect(result.status).toBe('applied');
    if (result.status === 'applied') expect(result.decision.calculatedLp).toBe(12);
  });
});

function sweepHarness(
  orders: LevelPassOrderFinancials[],
  storeOverrides: Partial<LevelPassSweepStore> = {},
) {
  const store: LevelPassSweepStore = {
    hasProcessedOrder: vi.fn(async () => false),
    findActiveSeason: vi.fn(async () => ({ id: 'season-1', endsAt: new Date('2026-12-01') })),
    getPlayerState: vi.fn(async () => state()),
    getCheckpointConfig: vi.fn(async () => CHECKPOINTS),
    applyDecision: vi.fn(async () => undefined),
    findUnprocessedOrders: vi.fn(async () => orders),
    markNotCreditable: vi.fn(async () => undefined),
    ...storeOverrides,
  };
  return { store };
}

describe('syncLevelPass', () => {
  it('does nothing when nothing is pending', async () => {
    const { store } = sweepHarness([]);
    const result = await syncLevelPass({ store, lookbackMs: 86_400_000, batchSize: 50 });

    expect(result).toEqual({ examined: 0, applied: 0, skipped: 0, failed: 0 });
  });

  it('applies every pending order and counts each outcome', async () => {
    const { store } = sweepHarness([order({ orderId: 'a' }), order({ orderId: 'b' })]);
    const result = await syncLevelPass({ store, lookbackMs: 86_400_000, batchSize: 50 });

    expect(result).toEqual({ examined: 2, applied: 2, skipped: 0, failed: 0 });
    expect(store.applyDecision).toHaveBeenCalledTimes(2);
  });

  it('counts a terminal skip (no linked account) separately from a failure', async () => {
    const { store } = sweepHarness([order({ orderId: 'a' })], {
      getPlayerState: vi.fn(async () => null),
    });
    const result = await syncLevelPass({ store, lookbackMs: 86_400_000, batchSize: 50 });

    expect(result).toEqual({ examined: 1, applied: 0, skipped: 1, failed: 0 });
    // Marked, or it fills a batch slot every 30s for the whole lookback window
    // and crowds out newer orders that *can* be credited.
    expect(store.markNotCreditable).toHaveBeenCalledWith('a');
  });

  it('does not mark a skip caused only by there being no season yet', async () => {
    const { store } = sweepHarness([order({ orderId: 'a' })], {
      findActiveSeason: vi.fn(async () => null),
    });
    const result = await syncLevelPass({ store, lookbackMs: 86_400_000, batchSize: 50 });

    expect(result).toEqual({ examined: 1, applied: 0, skipped: 1, failed: 0 });
    // This order earns LP the moment the client opens a season — marking it
    // would silently cost a real buyer their points.
    expect(store.markNotCreditable).not.toHaveBeenCalled();
  });

  it('keeps going and reports the failure when one order throws', async () => {
    const { store } = sweepHarness([order({ orderId: 'a' }), order({ orderId: 'b' })], {
      applyDecision: vi
        .fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce(undefined),
    });
    const result = await syncLevelPass({ store, lookbackMs: 86_400_000, batchSize: 50 });

    expect(result).toEqual({ examined: 2, applied: 1, skipped: 0, failed: 1 });
  });

  it('passes the lookback window and batch size through to the query', async () => {
    const now = new Date('2026-10-10T00:00:00Z');
    const { store } = sweepHarness([]);
    await syncLevelPass({ store, lookbackMs: 3_600_000, batchSize: 7, now: () => now });

    expect(store.findUnprocessedOrders).toHaveBeenCalledWith({
      completedAfter: new Date('2026-10-09T23:00:00Z'),
      limit: 7,
    });
  });
});

const usd = (n: number) => (n * 10_000) as UsdTenK;

const reward = (overrides: Partial<PendingCheckpointReward> = {}): PendingCheckpointReward => ({
  checkpointEventId: 'event-1',
  seasonId: 'season-1',
  playerId: '100001',
  checkpointLp: 60,
  rewardDiamonds: 110,
  recipe: [{ baseProductId: 'bp-100', diamondsBase: 100 }],
  ...overrides,
});

const catalogEntry = (overrides: Partial<ResolvedRewardCatalogEntry> = {}): ResolvedRewardCatalogEntry => ({
  providerProductId: 'prov-100',
  baseProductId: 'bp-100',
  endpointKind: 'pins_recharge',
  diamondsBase: 100,
  costUsd: usd(1),
  active: true,
  ...overrides,
});

function rewardStoreHarness(overrides: Partial<RewardFulfillmentStore> = {}): RewardFulfillmentStore {
  return {
    findGrantableCheckpointEvents: vi.fn(async () => []),
    resolveRewardCatalog: vi.fn(async () => [catalogEntry()]),
    createRewardOrder: vi.fn(async () => ({ created: true, orderId: 'order-r1', orderNumber: 'LU-TEST' })),
    findCompletedRewardOrders: vi.fn(async () => []),
    grantReward: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('createPendingRewardOrders', () => {
  it('does nothing when nothing is grantable', async () => {
    const store = rewardStoreHarness();
    const result = await createPendingRewardOrders({ store }, 50);
    expect(result).toEqual({ examined: 0, created: 0, unresolved: 0, failed: 0 });
  });

  it('resolves the recipe against the live catalog and creates an order', async () => {
    const store = rewardStoreHarness({
      findGrantableCheckpointEvents: vi.fn(async () => [reward()]),
    });
    const result = await createPendingRewardOrders({ store }, 50);

    expect(result).toEqual({ examined: 1, created: 1, unresolved: 0, failed: 0 });
    expect(store.resolveRewardCatalog).toHaveBeenCalledWith(['bp-100']);
    expect(store.createRewardOrder).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointEventId: 'event-1' }),
      [
        expect.objectContaining({
          sequence: 0,
          baseProductId: 'bp-100',
          providerProductId: 'prov-100',
          diamondsBase: 100,
          costUsd: usd(1),
        }),
      ],
    );
  });

  it('counts as unresolved, not failed, when the recipe product is inactive', async () => {
    const store = rewardStoreHarness({
      findGrantableCheckpointEvents: vi.fn(async () => [reward()]),
      resolveRewardCatalog: vi.fn(async () => [catalogEntry({ active: false })]),
    });
    const result = await createPendingRewardOrders({ store }, 50);

    expect(result).toEqual({ examined: 1, created: 0, unresolved: 1, failed: 0 });
    expect(store.createRewardOrder).not.toHaveBeenCalled();
  });

  it('counts as unresolved when the catalog has no synced cost yet', async () => {
    const store = rewardStoreHarness({
      findGrantableCheckpointEvents: vi.fn(async () => [reward()]),
      resolveRewardCatalog: vi.fn(async () => [catalogEntry({ costUsd: null })]),
    });
    const result = await createPendingRewardOrders({ store }, 50);
    expect(result.unresolved).toBe(1);
  });

  it('counts as unresolved when a recipe line has no matching catalog row at all', async () => {
    const store = rewardStoreHarness({
      findGrantableCheckpointEvents: vi.fn(async () => [reward()]),
      resolveRewardCatalog: vi.fn(async () => []),
    });
    const result = await createPendingRewardOrders({ store }, 50);
    expect(result.unresolved).toBe(1);
  });

  it('keeps going and reports the failure when one reward throws', async () => {
    const store = rewardStoreHarness({
      findGrantableCheckpointEvents: vi.fn(async () => [reward({ checkpointEventId: 'a' }), reward({ checkpointEventId: 'b' })]),
      createRewardOrder: vi
        .fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce({ created: true, orderId: 'order-r2', orderNumber: 'LU-TEST2' }),
    });
    const result = await createPendingRewardOrders({ store }, 50);
    expect(result).toEqual({ examined: 2, created: 1, unresolved: 0, failed: 1 });
  });
});

describe('grantCompletedRewardOrders', () => {
  const grantable = (overrides: Partial<GrantableRewardOrder> = {}): GrantableRewardOrder => ({
    checkpointEventId: 'event-1',
    seasonId: 'season-1',
    rewardOrderId: 'order-r1',
    internalCostCents: 1_200,
    ...overrides,
  });

  it('does nothing when nothing has completed', async () => {
    const store = rewardStoreHarness();
    const result = await grantCompletedRewardOrders({ store }, 50);
    expect(result).toEqual({ examined: 0, granted: 0, failed: 0 });
  });

  it('grants every completed reward order', async () => {
    const store = rewardStoreHarness({
      findCompletedRewardOrders: vi.fn(async () => [grantable({ checkpointEventId: 'a' }), grantable({ checkpointEventId: 'b' })]),
    });
    const result = await grantCompletedRewardOrders({ store }, 50);
    expect(result).toEqual({ examined: 2, granted: 2, failed: 0 });
    expect(store.grantReward).toHaveBeenCalledTimes(2);
  });

  it('keeps going and reports the failure when one grant throws', async () => {
    const store = rewardStoreHarness({
      findCompletedRewardOrders: vi.fn(async () => [grantable({ checkpointEventId: 'a' }), grantable({ checkpointEventId: 'b' })]),
      grantReward: vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(undefined),
    });
    const result = await grantCompletedRewardOrders({ store }, 50);
    expect(result).toEqual({ examined: 2, granted: 1, failed: 1 });
  });
});
