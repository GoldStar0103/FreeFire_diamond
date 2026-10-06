/**
 * Level Pass: the order-completion event flow.
 *
 * Level Points (LP) are a customer-friendly stand-in for roughly $1 MXN of
 * net profit per paid order. The customer must never see that relationship —
 * this module only computes numbers; nothing here renders copy.
 *
 * Split deliberately in two:
 *   - `decideLevelPassOutcome` is pure: given the player's *current* season
 *     state and one order's financials, it returns what should happen. No
 *     I/O, so the entire checkpoint-crossing matrix (including "skips two
 *     checkpoints in one huge purchase") runs as plain data-in/data-out tests.
 *   - `processOrderCompletion` is the thin orchestration: fetch current
 *     state, call the pure function, hand the decision to the store to apply
 *     atomically. The store — not this module — is responsible for actually
 *     writing season_player_stats/level_pass_lp_transactions/
 *     level_pass_checkpoint_events/vault_entitlements together.
 *
 * Idempotency has two layers, same "defense in depth" discipline as
 * `catalog-sync.ts`'s repointProducts: `hasProcessedOrder` lets the
 * orchestration skip redundant work cheaply, and the DB's own unique index on
 * `level_pass_lp_transactions.order_id` (and on
 * `level_pass_checkpoint_events(season, player, checkpoint_lp)`) is the actual
 * guarantee if two processes race on the same order.
 *
 * Free Level Pass rewards (diamonds delivered because a checkpoint was
 * reached) never flow back through this function — they are not "orders" in
 * the paid sense, so nothing here generates recursive LP for them. That is
 * enforced simply by never calling this for a reward delivery, not by a
 * special case in the logic below.
 */

export interface LevelPassCheckpointConfig {
  /** Cumulative LP threshold, e.g. 60, 260, 585, 1185. */
  lp: number;
  rewardDiamonds: number;
  /** Internal cost of that reward, frozen onto the grant when awarded. */
  costCents: number;
}

export interface LevelPassOrderFinancials {
  orderId: string;
  playerId: string;
  saleAmountCents: number;
  productCostCents: number;
  paymentFeeCents: number;
  /** Paid diamonds actually delivered by this order — drives ranking, not LP. */
  diamonds: number;
  /** Set only when an admin manually overrides the calculated LP for this order. */
  manualLpOverride?: { lp: number; adminId: string; reason?: string };
}

export interface LevelPassCurrentState {
  seasonId: string;
  playerProfileId: string;
  /** This season's LP before this order. */
  currentLp: number;
  /** Checkpoint LP values already granted this season — crossing is cumulative. */
  reachedCheckpoints: number[];
}

export interface CheckpointGrant {
  checkpointLp: number;
  rewardDiamonds: number;
  costCents: number;
}

export interface LevelPassDecision {
  estimatedProfitCents: number;
  calculatedLp: number;
  awardedLp: number;
  newLp: number;
  /** Ascending by checkpointLp. Empty if this order crossed nothing new. */
  newlyCrossedCheckpoints: CheckpointGrant[];
  /** True exactly when the highest configured checkpoint is newly crossed. */
  vaultUnlocked: boolean;
}

export type LpRoundingRule = 'round' | 'floor' | 'ceil';

const roundCents = (profitCents: number, rule: LpRoundingRule): number => {
  const pesos = profitCents / 100;
  switch (rule) {
    case 'floor':
      return Math.floor(pesos);
    case 'ceil':
      return Math.ceil(pesos);
    default:
      return Math.round(pesos);
  }
};

/**
 * Pure LP decision for one order. `checkpoints` need not be pre-sorted; this
 * sorts defensively rather than trusting the caller (the config ultimately
 * comes from an admin-editable `settings` row).
 */
export function decideLevelPassOutcome(
  state: LevelPassCurrentState,
  order: LevelPassOrderFinancials,
  checkpoints: LevelPassCheckpointConfig[],
  roundingRule: LpRoundingRule = 'round',
): LevelPassDecision {
  const estimatedProfitCents =
    order.saleAmountCents - order.productCostCents - order.paymentFeeCents;

  // A calculated LP below zero would silently erase progress on a thin-margin
  // or loss-leading order — clamp instead, same spirit as "self-financing"
  // rather than "self-punishing".
  const calculatedLp = Math.max(0, roundCents(estimatedProfitCents, roundingRule));
  const awardedLp = order.manualLpOverride ? Math.max(0, order.manualLpOverride.lp) : calculatedLp;
  const newLp = state.currentLp + awardedLp;

  const sorted = [...checkpoints].sort((a, b) => a.lp - b.lp);
  const reached = new Set(state.reachedCheckpoints);
  const newlyCrossedCheckpoints: CheckpointGrant[] = sorted
    .filter((cp) => cp.lp <= newLp && !reached.has(cp.lp))
    .map((cp) => ({ checkpointLp: cp.lp, rewardDiamonds: cp.rewardDiamonds, costCents: cp.costCents }));

  const finalCheckpointLp = sorted.at(-1)?.lp;
  const vaultUnlocked =
    finalCheckpointLp !== undefined &&
    newlyCrossedCheckpoints.some((g) => g.checkpointLp === finalCheckpointLp);

  return { estimatedProfitCents, calculatedLp, awardedLp, newLp, newlyCrossedCheckpoints, vaultUnlocked };
}

export interface LevelPassStore {
  /** Null means no eligible order feeds this — caller skips the whole flow. */
  findActiveSeason(): Promise<{ id: string; endsAt: Date } | null>;
  /** Null means this Free Fire ID has no linked account — not eligible yet. */
  getPlayerState(seasonId: string, playerId: string): Promise<LevelPassCurrentState | null>;
  getCheckpointConfig(): Promise<LevelPassCheckpointConfig[]>;
  hasProcessedOrder(orderId: string): Promise<boolean>;
  /**
   * Apply the decision atomically: season_player_stats (LP + seasonal
   * diamonds), player_profiles lifetime counters, the frozen
   * level_pass_lp_transactions row, one level_pass_checkpoint_events row per
   * newly crossed checkpoint, and — when `decision.vaultUnlocked` — a
   * vault_entitlements row plus the Level Pass Completed badge.
   */
  applyDecision(
    seasonId: string,
    playerProfileId: string,
    order: LevelPassOrderFinancials,
    decision: LevelPassDecision,
  ): Promise<void>;
}

export interface LevelPassDeps {
  store: LevelPassStore;
  roundingRule?: LpRoundingRule;
}

export type LevelPassOutcome =
  | { status: 'applied'; decision: LevelPassDecision }
  | { status: 'already_processed' }
  | { status: 'no_active_season' }
  | { status: 'no_linked_account' };

export async function processOrderCompletion(
  deps: LevelPassDeps,
  order: LevelPassOrderFinancials,
): Promise<LevelPassOutcome> {
  if (await deps.store.hasProcessedOrder(order.orderId)) {
    return { status: 'already_processed' };
  }

  const season = await deps.store.findActiveSeason();
  if (!season) return { status: 'no_active_season' };

  const state = await deps.store.getPlayerState(season.id, order.playerId);
  if (!state) return { status: 'no_linked_account' };

  const checkpoints = await deps.store.getCheckpointConfig();
  const decision = decideLevelPassOutcome(state, order, checkpoints, deps.roundingRule);
  await deps.store.applyDecision(season.id, state.playerProfileId, order, decision);

  return { status: 'applied', decision };
}

/**
 * The sweep-loop entry point, same shape as `reportConversions`: find
 * candidate rows the store has not yet handled, process each one, survive
 * and log one failure instead of letting it block the batch. An order that
 * comes back `no_active_season`/`no_linked_account` is a terminal skip, not
 * a failure to retry — it will never become eligible on its own, so it is
 * not worth re-examining every sweep (the store's own `findUnprocessedOrders`
 * query excludes anything already in `level_pass_lp_transactions`, but a
 * skipped order has no such row, so without the `completedAfter` window this
 * would re-scan it forever).
 */
export interface LevelPassSweepStore extends LevelPassStore {
  /** Completed orders, in the window, with no level_pass_lp_transactions row yet. */
  findUnprocessedOrders(input: { completedAfter: Date; limit: number }): Promise<LevelPassOrderFinancials[]>;
}

export interface LevelPassSweepDeps extends LevelPassDeps {
  store: LevelPassSweepStore;
  /** How far back to look for newly-completed orders. */
  lookbackMs: number;
  batchSize: number;
  now?: () => Date;
}

export interface LevelPassSweepResult {
  examined: number;
  applied: number;
  skipped: number;
  failed: number;
}

export async function syncLevelPass(deps: LevelPassSweepDeps): Promise<LevelPassSweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const completedAfter = new Date(now.getTime() - deps.lookbackMs);
  const pending = await deps.store.findUnprocessedOrders({ completedAfter, limit: deps.batchSize });

  const result: LevelPassSweepResult = { examined: pending.length, applied: 0, skipped: 0, failed: 0 };

  for (const order of pending) {
    try {
      const outcome = await processOrderCompletion(deps, order);
      if (outcome.status === 'applied') result.applied++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      console.error(`[level-pass] Could not process order ${order.orderId}: ${String(err)}`);
    }
  }

  return result;
}
