import { describe, expect, it } from 'vitest';
import { planLpOverride, type LpOverrideInput } from './lp-override.js';
import type { ReversibleCheckpoint } from './order-reversal.js';
import type { LevelPassCheckpointConfig } from './level-pass.js';

const LADDER: LevelPassCheckpointConfig[] = [
  { lp: 60, rewardDiamonds: 110, costCents: 1_200, recipe: [] },
  { lp: 260, rewardDiamonds: 340, costCents: 4_000, recipe: [] },
  { lp: 585, rewardDiamonds: 570, costCents: 6_500, recipe: [] },
];

const event = (
  checkpointLp: number,
  status: ReversibleCheckpoint['status'] = 'pending',
  extra: Partial<ReversibleCheckpoint> = {},
): ReversibleCheckpoint => ({
  checkpointEventId: `cp-${checkpointLp}`,
  checkpointLp,
  status,
  ...extra,
});

const input = (overrides: Partial<LpOverrideInput> = {}): LpOverrideInput => ({
  previousAwardedLp: 10,
  newAwardedLp: 10,
  currentLp: 100,
  checkpoints: LADDER,
  existing: [],
  vaultUnlocked: false,
  ...overrides,
});

describe('planLpOverride', () => {
  it('applies the delta to the season total, not the new value', () => {
    // The player has 100 LP, of which this order contributed 10. Raising the
    // order to 50 should leave them on 140, not 50.
    const plan = planLpOverride(input({ previousAwardedLp: 10, newAwardedLp: 50, currentLp: 100 }));

    expect(plan.lpDelta).toBe(40);
    expect(plan.newLp).toBe(140);
  });

  it('lowers the total when the override is smaller', () => {
    const plan = planLpOverride(input({ previousAwardedLp: 80, newAwardedLp: 20, currentLp: 100 }));

    expect(plan.lpDelta).toBe(-60);
    expect(plan.newLp).toBe(40);
  });

  it('clamps a negative override to zero rather than subtracting twice', () => {
    const plan = planLpOverride(input({ previousAwardedLp: 10, newAwardedLp: -5, currentLp: 100 }));

    expect(plan.newAwardedLp).toBe(0);
    expect(plan.newLp).toBe(90);
  });

  it('floors the season total at zero', () => {
    const plan = planLpOverride(input({ previousAwardedLp: 200, newAwardedLp: 0, currentLp: 50 }));
    expect(plan.newLp).toBe(0);
  });

  it('creates the checkpoints a generous override newly crosses', () => {
    const plan = planLpOverride(
      input({ previousAwardedLp: 10, newAwardedLp: 300, currentLp: 20, existing: [] }),
    );

    // 20 - 10 + 300 = 310: clears 60 and 260, not 585.
    expect(plan.newLp).toBe(310);
    expect(plan.checkpointsToCreate.map((c) => c.checkpointLp)).toEqual([60, 260]);
    expect(plan.checkpointsToCreate[0]).toMatchObject({ rewardDiamonds: 110, costCents: 1_200 });
  });

  it('does not re-create a checkpoint the player already has', () => {
    const plan = planLpOverride(
      input({
        previousAwardedLp: 10,
        newAwardedLp: 300,
        currentLp: 70,
        existing: [event(60, 'granted')],
      }),
    );

    expect(plan.checkpointsToCreate.map((c) => c.checkpointLp)).toEqual([260]);
  });

  it('revives a checkpoint reversed by an earlier refund instead of inserting a second one', () => {
    // One event per season/player/checkpoint is a DB constraint; a second
    // insert would fail outright.
    const plan = planLpOverride(
      input({
        previousAwardedLp: 0,
        newAwardedLp: 100,
        currentLp: 0,
        existing: [event(60, 'reversed')],
      }),
    );

    expect(plan.checkpointsToCreate).toEqual([]);
    expect(plan.checkpointEventIdsToRestore).toEqual(['cp-60']);
  });

  it('revokes a pending checkpoint a reduced override no longer covers', () => {
    const plan = planLpOverride(
      input({
        previousAwardedLp: 100,
        newAwardedLp: 10,
        currentLp: 120,
        existing: [event(60, 'pending')],
      }),
    );

    expect(plan.newLp).toBe(30);
    expect(plan.checkpointEventIdsToReverse).toEqual(['cp-60']);
  });

  it('never takes back a granted reward, and says why', () => {
    const plan = planLpOverride(
      input({
        previousAwardedLp: 100,
        newAwardedLp: 0,
        currentLp: 120,
        existing: [event(60, 'granted')],
      }),
    );

    expect(plan.checkpointEventIdsToReverse).toEqual([]);
    expect(plan.checkpointsKept).toEqual([
      { checkpointEventId: 'cp-60', checkpointLp: 60, reason: 'already_granted' },
    ]);
  });

  it('never takes back one whose reward order is already in flight', () => {
    const plan = planLpOverride(
      input({
        previousAwardedLp: 100,
        newAwardedLp: 0,
        currentLp: 120,
        existing: [event(60, 'pending', { rewardOrderPlaced: true })],
      }),
    );

    expect(plan.checkpointEventIdsToReverse).toEqual([]);
    expect(plan.checkpointsKept[0]?.reason).toBe('reward_in_flight');
  });

  it('unlocks the Vault when the override completes the Pass', () => {
    const plan = planLpOverride(
      input({ previousAwardedLp: 0, newAwardedLp: 600, currentLp: 0, vaultUnlocked: false }),
    );

    expect(plan.checkpointsToCreate.map((c) => c.checkpointLp)).toEqual([60, 260, 585]);
    expect(plan.unlockVault).toBe(true);
  });

  it('does not unlock a Vault the player already holds', () => {
    const plan = planLpOverride(
      input({ previousAwardedLp: 0, newAwardedLp: 600, currentLp: 0, vaultUnlocked: true }),
    );

    expect(plan.unlockVault).toBe(false);
  });

  it('closes the Vault when the final checkpoint is revoked', () => {
    const plan = planLpOverride(
      input({
        previousAwardedLp: 600,
        newAwardedLp: 0,
        currentLp: 600,
        vaultUnlocked: true,
        existing: [event(60, 'granted'), event(585, 'pending')],
      }),
    );

    expect(plan.checkpointEventIdsToReverse).toEqual(['cp-585']);
    expect(plan.closeVault).toBe(true);
  });

  it('leaves the Vault open when the completion reward was already delivered', () => {
    const plan = planLpOverride(
      input({
        previousAwardedLp: 600,
        newAwardedLp: 0,
        currentLp: 600,
        vaultUnlocked: true,
        existing: [event(585, 'granted')],
      }),
    );

    expect(plan.closeVault).toBe(false);
  });

  it('is a no-op plan when the value does not change', () => {
    const plan = planLpOverride(
      input({ previousAwardedLp: 60, newAwardedLp: 60, currentLp: 60, existing: [event(60, 'pending')] }),
    );

    expect(plan.lpDelta).toBe(0);
    expect(plan.newLp).toBe(60);
    expect(plan.checkpointsToCreate).toEqual([]);
    expect(plan.checkpointEventIdsToReverse).toEqual([]);
  });
});
