/**
 * Provider catalog sync.
 *
 * Mirrors the provider's Free Fire SKUs into `base_products`, which is what
 * combo recipes point at and what supplies the cost figure the wallet-delta
 * reconciliation compares against.
 *
 * Two rules the client's margins depend on:
 *
 *   1. Nothing is ever deleted. Recipes and historical order items reference
 *      these rows; a withdrawn product is deactivated so past orders stay
 *      readable and live combos fail loudly instead of losing their recipe.
 *
 *   2. Cost changes are reported, not silently applied. Revenue is fixed in
 *      MXN by a flyer for a month while cost floats in USD, so a supplier price
 *      rise can quietly turn a combo unprofitable. The client needs to be told.
 *
 * And three that exist because the provider can change its catalog under us —
 * RecargasAmérica announced exactly that for 2026-09-15, with no new docs:
 *
 *   3. An empty or unparseable catalog is not evidence that every product was
 *      withdrawn. A provider mid-migration that answers `[]`, or renames
 *      everything into strings `extractDiamonds` cannot read, would otherwise
 *      deactivate the whole store in one sync. When nothing maps, nothing is
 *      deactivated, and the result says so loudly.
 *
 *   4. A denomination is a denomination. When 100 diamonds moves from provider
 *      id 351 to some new id, that is a *replacement*: recipes and never-sent
 *      order items follow it to the new SKU, rather than every combo failing
 *      with PRODUCT_UNAVAILABLE and every paid order being dispatched to a dead
 *      id. Which SKU fulfils a denomination is an implementation detail.
 *
 *   5. A provider id that suddenly sells a *different* denomination is refused.
 *      Applying it would silently change what every recipe pointing at that row
 *      delivers — a 100-diamond slot quietly buying 5,600 — so it is reported,
 *      the stored row is withdrawn from sale, and a human decides.
 */

import type { ProviderProduct, TopupProvider, UsdTenK } from '@levelup/provider';
import { mapDenominations, rankProduct } from '@levelup/provider';

export interface StoredProduct {
  id: string;
  providerProductId: string;
  endpointKind: string;
  diamondsBase: number;
  costUsd: UsdTenK | null;
  active: boolean;
}

export interface ProductUpsert {
  providerProductId: string;
  endpointKind: ProviderProduct['endpointKind'];
  sku: string | null;
  name: string;
  diamondsBase: number;
  costUsd: UsdTenK;
  requiresServerId: boolean;
  canValidate: boolean;
}

/**
 * Move everything that references one provider product onto another of the
 * same denomination. `costUsd` is what the new SKU charges, and is what unsent
 * order items must carry from now on — wallet-delta reconciliation compares
 * the observed debit against it, so leaving the old cost in place would turn
 * every ambiguous call on a re-pointed item into `indeterminate`.
 */
export interface Repoint {
  denomination: number;
  fromProviderProductId: string;
  toProviderProductId: string;
  costUsd: UsdTenK;
}

export interface RepointOutcome extends Repoint {
  /** `combo_items` rows now pointing at the new product. */
  recipeItems: number;
  /** Unsent `order_items` rows now carrying the new product id and cost. */
  orderItems: number;
}

export interface CatalogSyncStore {
  listStoredProducts(): Promise<StoredProduct[]>;
  upsertProducts(products: ProductUpsert[]): Promise<void>;
  deactivateProducts(providerProductIds: string[]): Promise<void>;

  /**
   * Re-point recipes and unsent order items, atomically, with an audit row per
   * change. Called only after `upsertProducts`, so every target row exists.
   *
   * Implementations must never touch an item that may have reached the
   * provider (`sending`, `unknown`, `provider_pending`, `succeeded`) or any
   * item of an order that is finished — see the DB adapter for why each
   * exclusion matters.
   */
  repointProducts(repoints: Repoint[]): Promise<RepointOutcome[]>;
}

export interface CostChange {
  providerProductId: string;
  diamondsBase: number;
  previousUsd: UsdTenK;
  currentUsd: UsdTenK;
  /** Positive means the provider raised its price and margins have shrunk. */
  deltaUsd: UsdTenK;
  pctChange: number;
}

/** A denomination that was served by one active product and now maps to another. */
export interface Replacement {
  denomination: number;
  fromProviderProductId: string;
  toProviderProductId: string;
  previousCostUsd: UsdTenK | null;
  currentCostUsd: UsdTenK;
}

/**
 * A provider id offered as two different denominations at once: either a
 * known id that now parses as something other than what's stored for it, or
 * — `storedDiamonds` covers both — two rows in the very same catalog response
 * sharing an id but parsing to different amounts, which is exactly the same
 * kind of inconsistency and refused the same way.
 */
export interface DenominationConflict {
  providerProductId: string;
  name: string;
  storedDiamonds: number;
  offeredDiamonds: number;
}

export type DeactivationSkipReason =
  /** The provider returned zero Free Fire products. */
  | 'empty_catalog'
  /** Products came back, but none resolved to a usable denomination. */
  | 'nothing_mapped';

export interface CatalogSyncResult {
  /** Denominations now mapped to a usable product. */
  mapped: number[];
  /** Denominations with no provider product at all — combos using them break. */
  missing: number[];
  added: string[];
  updated: string[];
  deactivated: string[];
  costChanges: CostChange[];
  /** Denominations whose provider product changed. Recipes and unsent items followed. */
  replaced: Replacement[];
  /**
   * Every re-point that actually moved a row — the replacements above, plus
   * stragglers still pointing at a product retired by an earlier sync (an order
   * created in the instant a previous sync was re-pointing, say).
   */
  repointed: RepointOutcome[];
  /** Provider ids refused because they now sell a different denomination. */
  denominationConflicts: DenominationConflict[];
  /** Products found but unusable, with the reason. */
  skipped: Array<{ providerProductId: string; name: string; reason: string }>;
  /** True when no denomination resolved to a direct top-up. */
  blocked: boolean;
  /**
   * Set when withdrawn products were deliberately left active because the
   * catalog itself looked broken. Callers must treat this as critical: the
   * store is still selling on the previous catalog, which may or may not still
   * be fulfillable.
   */
  deactivationSkipped: {
    reason: DeactivationSkipReason;
    /** What a healthy-looking catalog would have deactivated. */
    keptActive: string[];
  } | null;
}

export interface CatalogSyncDeps {
  store: CatalogSyncStore;
  provider: TopupProvider;
  /** Report a cost move of at least this fraction (0.02 = 2%). */
  costChangeThreshold?: number;
}

/**
 * Choose the product for one denomination from its ranked candidates.
 *
 * The provider's ordering is the tie-breaker `mapDenominations` uses, and it is
 * not stable across calls. Mid-migration the provider may well list the old
 * and the new SKU side by side; without a preference for the incumbent, each
 * hourly sync could flip between them, re-pointing recipes back and forth and
 * alerting every time. So an equally-ranked product we already sell wins. A
 * strictly better-ranked product (a validatable recharge replacing a games
 * package) still takes over.
 */
function pickProduct(
  candidates: ProviderProduct[],
  activeIds: ReadonlySet<string>,
): ProviderProduct | null {
  const best = candidates[0];
  if (!best) return null;

  const incumbent = candidates.find(
    (p) =>
      activeIds.has(p.providerProductId) &&
      p.costUsd !== null &&
      rankProduct(p) === rankProduct(best),
  );
  return incumbent ?? best;
}

export async function syncCatalog(deps: CatalogSyncDeps): Promise<CatalogSyncResult> {
  const threshold = deps.costChangeThreshold ?? 0.02;

  const catalog = await deps.provider.listFreeFireCatalog();
  const stored = await deps.store.listStoredProducts();
  const byProviderId = new Map(stored.map((p) => [p.providerProductId, p]));
  const activeIds = new Set(stored.filter((p) => p.active).map((p) => p.providerProductId));

  const matches = mapDenominations(catalog);
  const skipped: CatalogSyncResult['skipped'] = [];
  const denominationConflicts: DenominationConflict[] = [];
  const upserts: ProductUpsert[] = [];
  const mapped: number[] = [];
  const missing: number[] = [];
  // Provider ids already accepted into `upserts` this run, and which
  // denomination claimed each. `mapDenominations` groups a product under
  // exactly one denomination by its own diamondsBase, so the only way the
  // same id reaches a second denomination's candidate list is the response
  // itself being internally inconsistent — two rows sharing an id but
  // parsing to different amounts. Upserting both would crash the whole sync
  // (`ON CONFLICT DO UPDATE` cannot affect the same target twice in one
  // statement) rather than reporting the conflict the way an id reused from
  // the *stored* catalog already is, below.
  const claimedThisRun = new Map<string, number>();

  for (const match of matches) {
    const candidates = match.chosen ? [match.chosen, ...match.alternatives] : [];

    // An id already storing a different denomination, or already claimed by a
    // different denomination earlier in this very run. Upserting either would
    // rewrite `diamonds_base` on a row recipes and unsent items point at, or
    // crash the batch insert outright.
    const eligible = candidates.filter((candidate) => {
      const existing = byProviderId.get(candidate.providerProductId);
      const claimedAs = claimedThisRun.get(candidate.providerProductId);
      const conflictingDiamonds =
        existing && existing.diamondsBase !== match.denomination
          ? existing.diamondsBase
          : claimedAs !== undefined && claimedAs !== match.denomination
            ? claimedAs
            : null;
      if (conflictingDiamonds === null) return true;

      denominationConflicts.push({
        providerProductId: candidate.providerProductId,
        name: candidate.name,
        storedDiamonds: conflictingDiamonds,
        offeredDiamonds: match.denomination,
      });
      skipped.push({
        providerProductId: candidate.providerProductId,
        name: candidate.name,
        reason:
          claimedAs !== undefined
            ? `Also offered as ${claimedAs} diamonds elsewhere in this same catalog response — ` +
              `the provider sent inconsistent data for this id, refusing both`
            : `Stored as ${conflictingDiamonds} diamonds but now offered as ` +
              `${match.denomination} — refusing to change what existing recipes deliver`,
      });
      return false;
    });

    const product = pickProduct(eligible, activeIds);
    if (!product) {
      missing.push(match.denomination);
      continue;
    }

    // Claimed as soon as it's chosen, before the cost/pins_code checks below
    // — even a product this denomination ultimately can't use (no price, a
    // redeemable code) still proves the id maps to `match.denomination` in
    // this response, which is what makes it a genuine conflict if some other
    // denomination's match also picks the very same id.
    claimedThisRun.set(product.providerProductId, match.denomination);

    // Without a cost the wallet-delta check has nothing to compare against, so
    // storing the product would only let orders fail later at fulfilment.
    if (product.costUsd === null) {
      missing.push(match.denomination);
      skipped.push({
        providerProductId: product.providerProductId,
        name: product.name,
        reason: 'Provider returned no price',
      });
      continue;
    }

    // A redeemable code is not the product LevelUp sells. Store it as inactive
    // rather than silently wiring it into a "recarga directa" combo.
    if (product.endpointKind === 'pins_code') {
      missing.push(match.denomination);
      skipped.push({
        providerProductId: product.providerProductId,
        name: product.name,
        reason: 'Delivers a redeemable code, not a direct top-up',
      });
      continue;
    }

    mapped.push(match.denomination);
    upserts.push({
      providerProductId: product.providerProductId,
      endpointKind: product.endpointKind,
      sku: product.sku,
      name: product.name,
      diamondsBase: match.denomination,
      costUsd: product.costUsd,
      requiresServerId: product.requiresServerId,
      canValidate: product.canValidate,
    });
  }

  const costChanges: CostChange[] = [];
  const added: string[] = [];
  const updated: string[] = [];

  for (const upsert of upserts) {
    const existing = byProviderId.get(upsert.providerProductId);
    if (!existing) {
      added.push(upsert.providerProductId);
      continue;
    }

    updated.push(upsert.providerProductId);

    if (existing.costUsd !== null && existing.costUsd !== upsert.costUsd) {
      const delta = (upsert.costUsd - existing.costUsd) as UsdTenK;
      const pctChange = existing.costUsd === 0 ? Infinity : delta / existing.costUsd;

      if (Math.abs(pctChange) >= threshold) {
        costChanges.push({
          providerProductId: upsert.providerProductId,
          diamondsBase: upsert.diamondsBase,
          previousUsd: existing.costUsd,
          currentUsd: upsert.costUsd,
          deltaUsd: delta,
          pctChange: pctChange * 100,
        });
      }
    }
  }

  const stillOffered = new Set(upserts.map((u) => u.providerProductId));
  const withdrawn = stored
    .filter((p) => p.active && !stillOffered.has(p.providerProductId))
    .map((p) => p.providerProductId);

  // A conflicted id is positive evidence, not absence of it: the provider has
  // told us this id now means something else. It stops being sold even when the
  // rest of the catalog looks broken.
  const conflicted = new Set(
    denominationConflicts
      .map((c) => c.providerProductId)
      .filter((id) => activeIds.has(id)),
  );

  if (mapped.length === 0) {
    // Nothing usable came back, so there is nothing to upsert or re-point to.
    // Deactivating on this evidence would take the whole store down because
    // the provider had a bad minute — or a bad migration day.
    const forced = withdrawn.filter((id) => conflicted.has(id));
    if (forced.length > 0) await deps.store.deactivateProducts(forced);

    return {
      mapped,
      missing,
      added,
      updated,
      deactivated: forced,
      costChanges,
      replaced: [],
      repointed: [],
      denominationConflicts,
      skipped,
      blocked: true,
      deactivationSkipped: {
        reason: catalog.length === 0 ? 'empty_catalog' : 'nothing_mapped',
        keptActive: withdrawn.filter((id) => !conflicted.has(id)),
      },
    };
  }

  if (upserts.length > 0) await deps.store.upsertProducts(upserts);

  // Every other stored product of a mapped denomination hands its references
  // to the product now chosen. Active ones are replacements proper; inactive
  // ones are retired SKUs that should already have nothing pointing at them,
  // and re-pointing them is a cheap no-op that sweeps up any straggler.
  const repoints: Repoint[] = [];
  const replaced: Replacement[] = [];
  for (const upsert of upserts) {
    for (const previous of stored) {
      if (previous.diamondsBase !== upsert.diamondsBase) continue;
      if (previous.providerProductId === upsert.providerProductId) continue;

      repoints.push({
        denomination: upsert.diamondsBase,
        fromProviderProductId: previous.providerProductId,
        toProviderProductId: upsert.providerProductId,
        costUsd: upsert.costUsd,
      });

      if (previous.active) {
        replaced.push({
          denomination: upsert.diamondsBase,
          fromProviderProductId: previous.providerProductId,
          toProviderProductId: upsert.providerProductId,
          previousCostUsd: previous.costUsd,
          currentCostUsd: upsert.costUsd,
        });
      }
    }
  }

  // Before deactivation, so there is never a moment where a recipe points at an
  // inactive row while its replacement sits ready. If the process dies in
  // between, the old row is still active and the next sync redoes this.
  const outcomes = repoints.length > 0 ? await deps.store.repointProducts(repoints) : [];
  const repointed = outcomes.filter((o) => o.recipeItems > 0 || o.orderItems > 0);

  // Anything previously active that the provider no longer offers. Deactivated,
  // never deleted — order items and combo recipes still point at these rows.
  if (withdrawn.length > 0) await deps.store.deactivateProducts(withdrawn);

  return {
    mapped,
    missing,
    added,
    updated,
    deactivated: withdrawn,
    costChanges,
    replaced,
    repointed,
    denominationConflicts,
    skipped,
    blocked: false,
    deactivationSkipped: null,
  };
}

const usdText = (value: UsdTenK | null): string =>
  value === null ? '?' : `$${(value / 10_000).toFixed(2)}`;

/** One line per replacement: `100: 351 -> 901 ($0.70 -> $0.72)`. */
export function describeReplacement(r: Replacement): string {
  return (
    `${r.denomination}: ${r.fromProviderProductId} -> ${r.toProviderProductId} ` +
    `(${usdText(r.previousCostUsd)} -> ${usdText(r.currentCostUsd)})`
  );
}

/** One-line summary for the console and the Telegram alert. */
export function summariseSync(result: CatalogSyncResult): string {
  const parts = [
    `${result.mapped.length}/6 denominations mapped`,
    `${result.added.length} added`,
    `${result.updated.length} updated`,
  ];
  if (result.deactivated.length) parts.push(`${result.deactivated.length} deactivated`);
  if (result.replaced.length) {
    parts.push(
      `${result.replaced.length} replaced [${result.replaced.map(describeReplacement).join('; ')}]`,
    );
  }
  const recipeItems = result.repointed.reduce((n, r) => n + r.recipeItems, 0);
  const orderItems = result.repointed.reduce((n, r) => n + r.orderItems, 0);
  if (recipeItems || orderItems) {
    parts.push(`re-pointed ${recipeItems} recipe item(s), ${orderItems} unsent order item(s)`);
  }
  if (result.costChanges.length) parts.push(`${result.costChanges.length} cost change(s)`);
  if (result.missing.length) parts.push(`MISSING: ${result.missing.join(', ')}`);
  if (result.denominationConflicts.length) {
    parts.push(
      `CONFLICT: ${result.denominationConflicts
        .map((c) => `${c.providerProductId} ${c.storedDiamonds}->${c.offeredDiamonds}`)
        .join(', ')}`,
    );
  }
  if (result.deactivationSkipped) {
    parts.push(
      `DEACTIVATION SKIPPED (${result.deactivationSkipped.reason}, ` +
        `${result.deactivationSkipped.keptActive.length} kept active)`,
    );
  }
  return parts.join(', ');
}
