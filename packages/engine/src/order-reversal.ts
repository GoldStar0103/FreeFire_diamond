/**
 * What reversing a completed order does to a player's Level Pass standing.
 *
 * The spec requires cancellation/refund to be an explicit policy rather than
 * something each caller improvises, so the decision lives here as a pure
 * function and the store just applies it. The policy, and why:
 *
 *   - LP and both diamond counters are unwound by exactly what the order
 *     added. The sale did not happen, so the progression it bought should not
 *     stand.
 *
 *   - A checkpoint the player reached but has NOT been paid out yet is
 *     revoked once their reduced LP no longer covers it. Nothing has left the
 *     business, so there is nothing to write off — it simply stops being owed.
 *
 *   - A checkpoint already GRANTED is never reversed, even if the player now
 *     falls far below it. Those diamonds are in a real Free Fire account and
 *     cannot be taken back, and the money they cost was really spent, so its
 *     ledger expense stands too. Pretending otherwise would make the accounts
 *     say LevelUp still has money it does not have. The grant is reported
 *     back to the caller instead, so a human can see what the reversal could
 *     not undo.
 *
 *   - Vault access closes only when the final checkpoint it depended on was
 *     itself revoked. If the completion reward was already delivered, the
 *     player keeps the Vault for the rest of the season: the perk was earned
 *     by an order that has been refunded, but withdrawing it after paying out
 *     the reward punishes the customer for an admin action and is not worth
 *     the support cost.
 *
 * Floors at zero everywhere: a counter is a running total and a season reset
 * or an out-of-order reversal could otherwise drive it negative, which no
 * screen in the product is prepared to render.
 */

export interface ReversibleCheckpoint {
  checkpointEventId: string;
  checkpointLp: number;
  status: 'pending' | 'granted' | 'reversed';
  /**
   * True once a reward order exists for this checkpoint. Such an order is
   * already moving through ordinary fulfilment and may be mid-flight at the
   * provider, so revoking the checkpoint would not stop the diamonds — it
   * would only lose the record that they are owed. Treated as unreversible
   * for the same reason an already-granted one is.
   */
  rewardOrderPlaced?: boolean;
}

/** Why the reversal could not undo a checkpoint the player no longer qualifies for. */
export type KeptCheckpointReason = 'already_granted' | 'reward_in_flight';

export interface OrderReversalInput {
  /** What the order's LP transaction recorded as awarded. */
  awardedLp: number;
  /** What it added to the lifetime diamond counter. */
  diamonds: number;
  /** What it added to the seasonal ranking counter — 0 for a non-linked ID. */
  rankingDiamonds: number;
  /** The player's LP in this season right now, before the reversal. */
  currentLp: number;
  /** Every checkpoint event this player has in this season. */
  checkpoints: ReversibleCheckpoint[];
  /** Whether the player currently holds Vault access for this season. */
  vaultUnlocked: boolean;
}

export interface OrderReversalPlan {
  lpRemoved: number;
  /** The player's LP after the reversal. */
  newLp: number;
  diamondsRemoved: number;
  rankingDiamondsRemoved: number;
  /** Pending checkpoints the reduced LP no longer covers. */
  checkpointEventIdsToReverse: string[];
  /**
   * Checkpoints the player no longer qualifies for but which could not be
   * undone. Surfaced rather than swallowed so the admin sees the real cost
   * this refund leaves behind.
   */
  checkpointsKept: Array<{
    checkpointEventId: string;
    checkpointLp: number;
    reason: KeptCheckpointReason;
  }>;
  closeVault: boolean;
}

export function planOrderReversal(input: OrderReversalInput): OrderReversalPlan {
  const lpRemoved = Math.max(0, input.awardedLp);
  const newLp = Math.max(0, input.currentLp - lpRemoved);

  const nowUnaffordable = input.checkpoints.filter((cp) => cp.checkpointLp > newLp);

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

  // The Vault hangs off the highest checkpoint in the ladder. If that exact
  // event is one being revoked here, the access it granted goes with it.
  const highest = input.checkpoints.reduce<ReversibleCheckpoint | null>(
    (best, cp) => (best === null || cp.checkpointLp > best.checkpointLp ? cp : best),
    null,
  );
  const closeVault =
    input.vaultUnlocked &&
    highest !== null &&
    checkpointEventIdsToReverse.includes(highest.checkpointEventId);

  return {
    lpRemoved,
    newLp,
    diamondsRemoved: Math.max(0, input.diamonds),
    rankingDiamondsRemoved: Math.max(0, input.rankingDiamonds),
    checkpointEventIdsToReverse,
    checkpointsKept,
    closeVault,
  };
}
