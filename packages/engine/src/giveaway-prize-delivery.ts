import type { EndpointKind, ProviderName, UsdTenK } from '@levelup/provider';

/**
 * Automatic delivery for `prizeType = 'diamonds'` giveaway winners — the
 * giveaway equivalent of `level-pass.ts`'s checkpoint reward delivery, same
 * two-phase async shape and for the same reason: a winner's prize is real
 * diamonds, delivered through the exact same provider call and
 * wallet-delta-reconciliation hazard a paid order has, so it reuses that
 * already-correct, already-tested machinery (`fulfillOrder`, the poller)
 * rather than a second, simpler delivery path.
 *
 * `prizeType = 'manual'` giveaways (an Evo box, a Booyah Pass — anything not
 * sourced from LevelUp's own diamond provider) never go through this module;
 * they stay the existing admin-confirms-by-hand flow.
 */

/**
 * Marks a synthetic order that delivers a giveaway prize rather than a real
 * sale — same convention as `level-pass.ts`'s `LEVEL_PASS_REWARD_COMBO_KEY`.
 * A plain, non-FK column on `orders`, never a real row in `combos`.
 * `accounting-queries.ts` excludes this key from every revenue/order-count
 * figure, same as the Level Pass one.
 */
export const GIVEAWAY_PRIZE_COMBO_KEY = 'giveaway_prize';

export interface GiveawayPrizeRecipeEntry {
  /** Pinned to a specific `base_products` row at save time, not to a `providerProductId` — see `giveaways.prizeRecipe`'s schema comment. */
  baseProductId: string;
  diamondsBase: number;
}

/** A winner whose prize order has not been created yet. */
export interface PendingGiveawayWinner {
  winnerId: string;
  giveawayId: string;
  giveawayTitle: string;
  /** Where the prize is actually sent — the ID verified at entry, not necessarily the account's linked season ID. */
  freeFireId: string;
  prizeDiamonds: number;
  recipe: GiveawayPrizeRecipeEntry[];
}

/** A `recipe` line resolved against the live catalog, ready to become an order item. */
export interface ResolvedGiveawayPrizeCatalogEntry {
  baseProductId: string;
  providerProductId: string;
  provider: ProviderName;
  endpointKind: EndpointKind;
  diamondsBase: number;
  /** Null when the catalog has not synced a cost for this product yet. */
  costUsd: UsdTenK | null;
  active: boolean;
}

export interface ResolvedGiveawayPrizeItem {
  sequence: number;
  baseProductId: string;
  providerProductId: string;
  provider: ProviderName;
  endpointKind: EndpointKind;
  diamondsBase: number;
  costUsd: UsdTenK;
}

/** A winner whose prize order has since reached `completed`. */
export interface GrantableGiveawayPrize {
  winnerId: string;
  giveawayId: string;
  deliveryOrderId: string;
  /** `costCentsSnapshot`, frozen on the winner row at draw time. */
  internalCostCents: number;
}

export interface GiveawayPrizeDeliveryStore {
  /** Winners of a `diamonds`-type giveaway with no delivery order created yet. */
  findPendingGiveawayWinners(limit: number): Promise<PendingGiveawayWinner[]>;
  /** Live catalog rows for the given `base_products.id`s, by that same id. */
  resolveGiveawayPrizeCatalog(baseProductIds: string[]): Promise<ResolvedGiveawayPrizeCatalogEntry[]>;
  /**
   * Creates the `$0` order and links it onto the winner row in one
   * transaction, guarded so a second call for the same winner is a no-op —
   * the real guard against ever creating two prize orders for one winner.
   */
  createGiveawayPrizeOrder(
    winner: PendingGiveawayWinner,
    items: ResolvedGiveawayPrizeItem[],
  ): Promise<{ created: boolean; orderId: string; orderNumber: string }>;
  /** Winner rows whose prize order reached `completed` since it was created. */
  findCompletedGiveawayPrizeOrders(limit: number): Promise<GrantableGiveawayPrize[]>;
  /** Marks the winner delivered and records the ledger expense, together, idempotently — and finalizes the giveaway once every winner is delivered. */
  grantGiveawayPrize(row: GrantableGiveawayPrize): Promise<void>;
}

export interface CreatePendingGiveawayPrizeOrdersResult {
  examined: number;
  created: number;
  /** Recipe did not resolve against the live catalog — needs an admin fix before this prize can be sold out from under itself. */
  unresolved: number;
  failed: number;
}

/**
 * Turn every winner of a `diamonds`-type giveaway into a real `$0` order the
 * existing fulfilment worker will pick up on its own next pass — nothing
 * here calls the provider directly.
 */
export async function createPendingGiveawayPrizeOrders(
  deps: { store: GiveawayPrizeDeliveryStore },
  batchSize: number,
): Promise<CreatePendingGiveawayPrizeOrdersResult> {
  const pending = await deps.store.findPendingGiveawayWinners(batchSize);
  const result: CreatePendingGiveawayPrizeOrdersResult = {
    examined: pending.length,
    created: 0,
    unresolved: 0,
    failed: 0,
  };

  for (const winner of pending) {
    try {
      const ids = [...new Set(winner.recipe.map((r) => r.baseProductId))];
      const catalog = await deps.store.resolveGiveawayPrizeCatalog(ids);
      const byId = new Map(catalog.map((c) => [c.baseProductId, c]));

      const items: ResolvedGiveawayPrizeItem[] = [];
      let unresolved = false;
      winner.recipe.forEach((entry, index) => {
        const match = byId.get(entry.baseProductId);
        if (!match || !match.active || match.costUsd === null) {
          unresolved = true;
          return;
        }
        items.push({
          sequence: index,
          baseProductId: match.baseProductId,
          providerProductId: match.providerProductId,
          provider: match.provider,
          endpointKind: match.endpointKind,
          diamondsBase: match.diamondsBase,
          costUsd: match.costUsd,
        });
      });

      if (unresolved || items.length === 0) {
        result.unresolved++;
        console.error(
          `[giveaway-prizes] Giveaway "${winner.giveawayTitle}" winner ${winner.winnerId} has no deliverable ` +
            `recipe against the live catalog — fix it in /sorteos before this can be delivered.`,
        );
        continue;
      }

      const outcome = await deps.store.createGiveawayPrizeOrder(winner, items);
      if (outcome.created) result.created++;
    } catch (err) {
      result.failed++;
      console.error(`[giveaway-prizes] Could not create a prize order for winner ${winner.winnerId}: ${String(err)}`);
    }
  }

  return result;
}

export interface GrantCompletedGiveawayPrizesResult {
  examined: number;
  granted: number;
  failed: number;
}

/** Close the loop: a prize order that finished delivering becomes a delivered winner and a ledger expense. */
export async function grantCompletedGiveawayPrizes(
  deps: { store: GiveawayPrizeDeliveryStore },
  batchSize: number,
): Promise<GrantCompletedGiveawayPrizesResult> {
  const completed = await deps.store.findCompletedGiveawayPrizeOrders(batchSize);
  const result: GrantCompletedGiveawayPrizesResult = { examined: completed.length, granted: 0, failed: 0 };

  for (const row of completed) {
    try {
      await deps.store.grantGiveawayPrize(row);
      result.granted++;
    } catch (err) {
      result.failed++;
      console.error(`[giveaway-prizes] Could not grant winner ${row.winnerId}: ${String(err)}`);
    }
  }

  return result;
}
