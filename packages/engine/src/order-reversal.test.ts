import { describe, expect, it } from 'vitest';
import { planOrderReversal, type OrderReversalInput, type ReversibleCheckpoint } from './order-reversal.js';

const cp = (
  checkpointLp: number,
  status: ReversibleCheckpoint['status'] = 'pending',
  id = `cp-${checkpointLp}`,
): ReversibleCheckpoint => ({ checkpointEventId: id, checkpointLp, status });

const input = (overrides: Partial<OrderReversalInput> = {}): OrderReversalInput => ({
  awardedLp: 10,
  diamonds: 100,
  rankingDiamonds: 100,
  currentLp: 50,
  checkpoints: [],
  vaultUnlocked: false,
  ...overrides,
});

describe('planOrderReversal', () => {
  it('unwinds exactly what the order added', () => {
    const plan = planOrderReversal(input({ awardedLp: 13, diamonds: 340, rankingDiamonds: 340, currentLp: 50 }));

    expect(plan).toMatchObject({
      lpRemoved: 13,
      newLp: 37,
      diamondsRemoved: 340,
      rankingDiamondsRemoved: 340,
    });
  });

  it('removes no ranking diamonds when the top-up was not to the linked ID', () => {
    // Level Pass LP still accrued for a secondary ID, the ranking did not â€”
    // so the reversal has to be just as asymmetric.
    const plan = planOrderReversal(input({ diamonds: 340, rankingDiamonds: 0 }));

    expect(plan.diamondsRemoved).toBe(340);
    expect(plan.rankingDiamondsRemoved).toBe(0);
  });

  it('floors LP at zero rather than going negative', () => {
    const plan = planOrderReversal(input({ awardedLp: 80, currentLp: 50 }));

    expect(plan.lpRemoved).toBe(80);
    expect(plan.newLp).toBe(0);
  });

  it('revokes a pending checkpoint the reduced LP no longer covers', () => {
    const plan = planOrderReversal(
      input({ awardedLp: 10, currentLp: 65, checkpoints: [cp(60, 'pending')] }),
    );

    // 65 - 10 = 55, below the 60 LP checkpoint.
    expect(plan.checkpointEventIdsToReverse).toEqual(['cp-60']);
    expect(plan.checkpointsKept).toEqual([]);
  });

  it('keeps a pending checkpoint the player can still afford', () => {
    const plan = planOrderReversal(
      input({ awardedLp: 5, currentLp: 65, checkpoints: [cp(60, 'pending')] }),
    );

    expect(plan.checkpointEventIdsToReverse).toEqual([]);
  });

  it('never reverses an already-granted checkpoint â€” those diamonds are gone', () => {
    const plan = planOrderReversal(
      input({ awardedLp: 40, currentLp: 65, checkpoints: [cp(60, 'granted')] }),
    );

    expect(plan.checkpointEventIdsToReverse).toEqual([]);
    expect(plan.checkpointsKept).toEqual([{ checkpointEventId: 'cp-60', checkpointLp: 60, reason: 'already_granted' }]);
  });

  it('reverses only the pending ones when a player holds both', () => {
    const plan = planOrderReversal(
      input({
        awardedLp: 600,
        currentLp: 700,
        checkpoints: [cp(60, 'granted'), cp(260, 'granted'), cp(585, 'pending')],
      }),
    );

    // 700 - 600 = 100: below 260 and 585, still above 60.
    expect(plan.newLp).toBe(100);
    expect(plan.checkpointEventIdsToReverse).toEqual(['cp-585']);
    expect(plan.checkpointsKept).toEqual([{ checkpointEventId: 'cp-260', checkpointLp: 260, reason: 'already_granted' }]);
  });

  it('ignores a checkpoint already reversed by an earlier refund', () => {
    const plan = planOrderReversal(
      input({ awardedLp: 40, currentLp: 65, checkpoints: [cp(60, 'reversed')] }),
    );

    expect(plan.checkpointEventIdsToReverse).toEqual([]);
    expect(plan.checkpointsKept).toEqual([]);
  });

  it('will not revoke a pending checkpoint whose reward order is already in flight', () => {
    // Revoking it would not recall the diamonds — fulfilment is already
    // carrying that order — it would only lose the record that they are owed.
    const plan = planOrderReversal(
      input({
        awardedLp: 40,
        currentLp: 65,
        checkpoints: [{ checkpointEventId: 'cp-60', checkpointLp: 60, status: 'pending', rewardOrderPlaced: true }],
      }),
    );

    expect(plan.checkpointEventIdsToReverse).toEqual([]);
    expect(plan.checkpointsKept).toEqual([
      { checkpointEventId: 'cp-60', checkpointLp: 60, reason: 'reward_in_flight' },
    ]);
  });

  it('closes the Vault when the final checkpoint that unlocked it is revoked', () => {
    const plan = planOrderReversal(
      input({
        awardedLp: 100,
        currentLp: 1_200,
        vaultUnlocked: true,
        checkpoints: [cp(60, 'granted'), cp(1_185, 'pending')],
      }),
    );

    expect(plan.checkpointEventIdsToReverse).toEqual(['cp-1185']);
    expect(plan.closeVault).toBe(true);
  });

  it('leaves the Vault open when the completion reward was already delivered', () => {
    const plan = planOrderReversal(
      input({
        awardedLp: 100,
        currentLp: 1_200,
        vaultUnlocked: true,
        checkpoints: [cp(1_185, 'granted')],
      }),
    );

    expect(plan.closeVault).toBe(false);
    expect(plan.checkpointsKept).toHaveLength(1);
  });

  it('leaves the Vault open when the player still clears the final checkpoint', () => {
    const plan = planOrderReversal(
      input({
        awardedLp: 10,
        currentLp: 1_200,
        vaultUnlocked: true,
        checkpoints: [cp(1_185, 'pending')],
      }),
    );

    expect(plan.checkpointEventIdsToReverse).toEqual([]);
    expect(plan.closeVault).toBe(false);
  });

  it('does not close a Vault the player never had', () => {
    const plan = planOrderReversal(
      input({ awardedLp: 100, currentLp: 1_200, vaultUnlocked: false, checkpoints: [cp(1_185, 'pending')] }),
    );

    expect(plan.closeVault).toBe(false);
  });
});
