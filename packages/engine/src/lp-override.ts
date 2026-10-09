/**
 * Manually changing the Level Points an order awarded.
 *
 * The spec asks for an authorised admin to be able to override the
 * automatically calculated LP for an exceptional order, keeping BOTH the
 * calculated and the final awarded value plus who changed it and why. The
 * calculated figure is never touched by this — it stays as the record of what
 * the formula said, which is the only way to later tell a generous override
 * from a bad cost input.
 *
 * Changing LP after the fact is not just an arithmetic edit: it can push a
 * player across a checkpoint they had not reached, or pull them back below
 * one they had. Both directions are planned here so neither is left to the
 * caller to remember.
 *
 * The downward direction follows exactly the same policy as a refund (see
 * `order-reversal.ts`): a reward already granted, or one whose reward order
 * is already in flight, is never taken back, because those diamonds are in a
 * real account and the money for them was really spent.
 */

import type { LevelPassCheckpointConfig, CheckpointGrant } from './level-pass.js';
import type { KeptCheckpointReason, ReversibleCheckpoint } from './order-reversal.js';

export interface LpOverrideInput {
  /** What the order awarded before this change. */
  previousAwardedLp: number;
  /** What the admin is setting it to. Clamped at zero. */
  newAwardedLp: number;
  /** The player's season LP right now, which already includes the previous award. */
  currentLp: number;
  /** The configured ladder. Need not be sorted. */
  checkpoints: LevelPassCheckpointConfig[];
  /** Every checkpoint event this player has in this season. */
  existing: ReversibleCheckpoint[];
  vaultUnlocked: boolean;
}

export interface LpOverridePlan {
  previousAwardedLp: number;
  newAwardedLp: number;
  /** Signed: positive when the override is generous. */
  lpDelta: number;
  newLp: number;
  /** Crossed by the new total, with no event of any kind yet. */
  checkpointsToCreate: CheckpointGrant[];
  /**
   * Crossed again, but an event already exists in `reversed` state from an
   * earlier refund. Revived rather than re-inserted: one event per
   * season/player/checkpoint is a database constraint, so a second insert
   * would fail.
   */
  checkpointEventIdsToRestore: string[];
  /** Pending, no reward order yet, and no longer covered by the new total. */
  checkpointEventIdsToReverse: string[];
  /** No longer covered, but impossible to take back. */
  checkpointsKept: Array<{
    checkpointEventId: string;
    checkpointLp: number;
    reason: KeptCheckpointReason;
  }>;
  unlockVault: boolean;
  closeVault: boolean;
}

export function planLpOverride(input: LpOverrideInput): LpOverridePlan {
  const previousAwardedLp = Math.max(0, input.previousAwardedLp);
  const newAwardedLp = Math.max(0, input.newAwardedLp);
  const lpDelta = newAwardedLp - previousAwardedLp;
  const newLp = Math.max(0, input.currentLp + lpDelta);

  const sorted = [...input.checkpoints].sort((a, b) => a.lp - b.lp);
  const byLp = new Map(input.existing.map((cp) => [cp.checkpointLp, cp]));

  const checkpointsToCreate: CheckpointGrant[] = [];
  const checkpointEventIdsToRestore: string[] = [];
  for (const cp of sorted) {
    if (cp.lp > newLp) continue;
    const event = byLp.get(cp.lp);
    if (!event) {
      checkpointsToCreate.push({
        checkpointLp: cp.lp,
        rewardDiamonds: cp.rewardDiamonds,
        costCents: cp.costCents,
      });
    } else if (event.status === 'reversed') {
      checkpointEventIdsToRestore.push(event.checkpointEventId);
    }
  }

  const nowUnaffordable = input.existing.filter((cp) => cp.checkpointLp > newLp);
  const checkpointEventIdsToReverse = nowUnaffordable
    .filter((cp) => cp.status === 'pending' && !cp.rewardOrderPlaced)
    .map((cp) => cp.checkpointEventId);
  const checkpointsKept = nowUnaffordable
    .filter((cp) => cp.status === 'granted' || (cp.status === 'pending' && cp.rewardOrderPlaced))
    .map((cp) => ({
      checkpointEventId: cp.checkpointEventId,
      checkpointLp: cp.checkpointLp,
      reason: (cp.status === 'granted' ? 'already_granted' : 'reward_in_flight') as KeptCheckpointReason,
    }));

  // The Vault hangs off the top of the configured ladder, not off whichever
  // event happens to be highest — a checkpoint removed from the config later
  // must not start deciding Vault access.
  const finalLp = sorted.at(-1)?.lp;
  const finalEvent = finalLp === undefined ? undefined : byLp.get(finalLp);

  const unlockVault =
    !input.vaultUnlocked &&
    finalLp !== undefined &&
    (checkpointsToCreate.some((c) => c.checkpointLp === finalLp) ||
      (finalEvent !== undefined && checkpointEventIdsToRestore.includes(finalEvent.checkpointEventId)));

  const closeVault =
    input.vaultUnlocked &&
    finalEvent !== undefined &&
    checkpointEventIdsToReverse.includes(finalEvent.checkpointEventId);

  return {
    previousAwardedLp,
    newAwardedLp,
    lpDelta,
    newLp,
    checkpointsToCreate,
    checkpointEventIdsToRestore,
    checkpointEventIdsToReverse,
    checkpointsKept,
    unlockVault,
    closeVault,
  };
}
