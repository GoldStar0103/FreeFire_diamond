import type { EndpointKind, UsdTenK } from '@levelup/provider';

/**
 * Level Pass: the order-completion event flow, and reward delivery.
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
 * special case in the logic below — AND by `findUnprocessedOrders` excluding
 * `LEVEL_PASS_REWARD_COMBO_KEY` orders explicitly, since the sweep below
 * discovers completed orders itself rather than being handed one.
 *
 * Reward delivery (`createPendingRewardOrders`/`grantCompletedRewardOrders`,
 * further down) deliberately reuses the real paid-order pipeline —
 * `fulfillOrder`, the poller, the wallet-delta ambiguity resolution — instead
 * of a second, simpler delivery path. A reward is free diamonds, but the
 * provider call that delivers them is the exact same call with the exact same
 * "never retry an ambiguous outcome blindly" hazard a real sale has; that
 * logic is already correct and already tested, so a checkpoint reward
 * becomes a normal `$0` order that the existing worker sweep fulfils like any
 * other, rather than a parallel implementation of the hard part.
 */

export interface LevelPassRewardRecipeEntry {
  /**
   * Pinned to a specific `base_products` row at save time, exactly like a
   * combo's `comboItems.baseProductId` — not to a `providerProductId`, which
   * a catalog re-sync can re-point onto a different row. `diamondsBase` is a
   * snapshot for display only; delivery re-reads the live row by id, so a
   * later re-sync that changes its cost or deactivates it is picked up
   * automatically, the same as a combo's recipe.
   */
  baseProductId: string;
  diamondsBase: number;
}

export interface LevelPassCheckpointConfig {
  /** Cumulative LP threshold, e.g. 60, 260, 585, 1185. */
  lp: number;
  rewardDiamonds: number;
  /** Internal cost of that reward, frozen onto the grant when awarded. */
  costCents: number;
  /**
   * What actually gets delivered: one or more provider denominations summing
   * to at least `rewardDiamonds` (checked with `checkRecipe`, same tolerance
   * rule combos use). Authored in /temporadas against the live synced
   * catalog — the provider has no denomination smaller than its own base
   * SKUs, so a reward that does not land exactly on one must over-deliver
   * onto the next one up, same as a combo would.
   */
  recipe: LevelPassRewardRecipeEntry[];
}

/**
 * Marks a synthetic order that delivers a free Level Pass reward rather than
 * a real sale. `combo_key` is a plain, non-FK column on `orders` for exactly
 * this reason — a reward order needs a stable marker but must never need a
 * real row in `combos` (which the admin catalog UI manages and would
 * otherwise have to know to hide). Accounting-queries.ts excludes this key
 * from every revenue/order-count figure; level-pass-store.ts excludes it from
 * the LP-award sweep so a free reward can never generate recursive LP.
 */
export const LEVEL_PASS_REWARD_COMBO_KEY = 'level_pass_reward';

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

// ── reward delivery ───────────────────────────────────────────────────────────

/** One checkpoint waiting for a reward order: reached, not yet delivered. */
export interface PendingCheckpointReward {
  checkpointEventId: string;
  seasonId: string;
  /** Free Fire ID — what the provider call actually tops up. */
  playerId: string;
  checkpointLp: number;
  rewardDiamonds: number;
  recipe: LevelPassRewardRecipeEntry[];
}

/** A `recipe` line resolved against the live catalog, ready to become an order item. */
export interface ResolvedRewardCatalogEntry {
  providerProductId: string;
  baseProductId: string;
  endpointKind: EndpointKind;
  diamondsBase: number;
  /** Null when the catalog has not synced a cost for this product yet. */
  costUsd: UsdTenK | null;
  active: boolean;
}

export interface ResolvedRewardItem {
  sequence: number;
  baseProductId: string;
  providerProductId: string;
  endpointKind: EndpointKind;
  diamondsBase: number;
  costUsd: UsdTenK;
}

/** A reward order whose items have all reached their terminal state as `completed`. */
export interface GrantableRewardOrder {
  checkpointEventId: string;
  seasonId: string;
  rewardOrderId: string;
  internalCostCents: number;
}

export interface RewardFulfillmentStore {
  /** Checkpoint events reached but with no reward order created yet. */
  findGrantableCheckpointEvents(limit: number): Promise<PendingCheckpointReward[]>;
  /** Live catalog rows for the given `base_products.id`s, by that same id. */
  resolveRewardCatalog(baseProductIds: string[]): Promise<ResolvedRewardCatalogEntry[]>;
  /**
   * Creates the `$0` order and links it onto the checkpoint event in one
   * transaction, guarded so a second call for the same event is a no-op —
   * the real guard against ever creating two reward orders for one grant.
   */
  createRewardOrder(
    reward: PendingCheckpointReward,
    items: ResolvedRewardItem[],
  ): Promise<{ created: boolean; orderId: string; orderNumber: string }>;
  /** Reward orders that reached `completed` since they were created. */
  findCompletedRewardOrders(limit: number): Promise<GrantableRewardOrder[]>;
  /** Marks the checkpoint granted and records the ledger expense, together, idempotently. */
  grantReward(row: GrantableRewardOrder): Promise<void>;
}

export interface CreatePendingRewardOrdersResult {
  examined: number;
  created: number;
  /** Recipe did not resolve against the live catalog — needs an admin fix in /temporadas. */
  unresolved: number;
  failed: number;
}

/**
 * Turn every reached-but-undelivered checkpoint into a real `$0` order the
 * existing fulfilment worker will pick up on its own next pass — nothing
 * here calls the provider directly.
 */
export async function createPendingRewardOrders(
  deps: { store: RewardFulfillmentStore },
  batchSize: number,
): Promise<CreatePendingRewardOrdersResult> {
  const pending = await deps.store.findGrantableCheckpointEvents(batchSize);
  const result: CreatePendingRewardOrdersResult = { examined: pending.length, created: 0, unresolved: 0, failed: 0 };

  for (const reward of pending) {
    try {
      const ids = [...new Set(reward.recipe.map((r) => r.baseProductId))];
      const catalog = await deps.store.resolveRewardCatalog(ids);
      const byId = new Map(catalog.map((c) => [c.baseProductId, c]));

      const items: ResolvedRewardItem[] = [];
      let unresolved = false;
      reward.recipe.forEach((entry, index) => {
        const match = byId.get(entry.baseProductId);
        if (!match || !match.active || match.costUsd === null) {
          unresolved = true;
          return;
        }
        items.push({
          sequence: index,
          baseProductId: match.baseProductId,
          providerProductId: match.providerProductId,
          endpointKind: match.endpointKind,
          diamondsBase: match.diamondsBase,
          costUsd: match.costUsd,
        });
      });

      if (unresolved || items.length === 0) {
        result.unresolved++;
        console.error(
          `[level-pass] Checkpoint ${reward.checkpointLp} reward for player ${reward.playerId} has no ` +
            `deliverable recipe against the live catalog — fix it in /temporadas before this can grant.`,
        );
        continue;
      }

      const outcome = await deps.store.createRewardOrder(reward, items);
      if (outcome.created) result.created++;
    } catch (err) {
      result.failed++;
      console.error(
        `[level-pass] Could not create a reward order for checkpoint event ${reward.checkpointEventId}: ${String(err)}`,
      );
    }
  }

  return result;
}

export interface GrantCompletedRewardsResult {
  examined: number;
  granted: number;
  failed: number;
}

/** Close the loop: a reward order that finished delivering becomes a granted checkpoint and a ledger expense. */
export async function grantCompletedRewardOrders(
  deps: { store: RewardFulfillmentStore },
  batchSize: number,
): Promise<GrantCompletedRewardsResult> {
  const completed = await deps.store.findCompletedRewardOrders(batchSize);
  const result: GrantCompletedRewardsResult = { examined: completed.length, granted: 0, failed: 0 };

  for (const row of completed) {
    try {
      await deps.store.grantReward(row);
      result.granted++;
    } catch (err) {
      result.failed++;
      console.error(`[level-pass] Could not grant checkpoint event ${row.checkpointEventId}: ${String(err)}`);
    }
  }

  return result;
}
