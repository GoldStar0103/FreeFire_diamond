import { describe, expect, it, vi } from 'vitest';
import {
  decideLevelPassOutcome,
  processOrderCompletion,
  type LevelPassCheckpointConfig,
  type LevelPassCurrentState,
  type LevelPassOrderFinancials,
  type LevelPassStore,
} from './level-pass.js';

const CHECKPOINTS: LevelPassCheckpointConfig[] = [
  { lp: 60, rewardDiamonds: 110, costCents: 1_200 },
  { lp: 260, rewardDiamonds: 340, costCents: 4_000 },
  { lp: 585, rewardDiamonds: 570, costCents: 6_500 },
  { lp: 1_185, rewardDiamonds: 1_160, costCents: 12_000 },
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
