/**
 * Switching the active provider — the mechanics behind Jose's "backup
 * activates automatically" request.
 *
 * Order creation already resolves a denomination's provider purely by
 * following `combo_items.base_product_id -> base_products` (see
 * `ordering-store.ts`), and the catalog sync already has a mechanism for "this
 * denomination's provider product id changed, move everything that
 * references it": `repointProducts` (see `catalog-sync.ts`'s module doc).
 * Switching RecargasAmérica -> Central One for a denomination is the exact
 * same operation, just crossing a provider boundary instead of staying
 * within one — so this file does not invent a new routing mechanism, it
 * reuses that one.
 *
 * Both providers' catalogs are expected to already be synced independently
 * and continuously in the background (two ordinary `syncCatalog` calls, one
 * per provider — see `runCatalogSync` in the worker). That means activating a
 * target provider never needs a live call to it: everything this function
 * needs is already sitting in `base_products`, tagged by provider.
 */

import type { ProviderName } from '@levelup/provider';
import { BASE_DENOMINATIONS } from '@levelup/provider';
import type { Alerter } from './ports.js';
import type { CatalogSyncStore, Repoint, RepointOutcome } from './catalog-sync.js';

export interface ActivateProviderDeps {
  store: CatalogSyncStore;
  alerter: Alerter;
  /** Persists the `active_provider` setting, with an audit trail — see `provider-routing.ts` in `@levelup/db`. */
  setActiveProvider: (provider: ProviderName, adminUserId: string | null) => Promise<void>;
}

export interface ActivateProviderResult {
  target: ProviderName;
  /** Denominations actually moved to the target provider this call. */
  switched: number[];
  /** Already on the target provider — nothing to do. */
  alreadyActive: number[];
  /**
   * Currently sold by some provider, but the target has no ready candidate
   * (not synced, inactive, or no price) — left untouched, never silently
   * dropped. A denomination nothing currently sells at all is not reported
   * here; switching providers cannot create a gap that didn't already exist.
   */
  skipped: number[];
  repointed: RepointOutcome[];
}

export async function activateProvider(
  deps: ActivateProviderDeps,
  target: ProviderName,
  adminUserId: string | null = null,
): Promise<ActivateProviderResult> {
  const { store, alerter, setActiveProvider } = deps;

  // What combo recipes actually point at right now, read directly rather than
  // assumed — correct even if a previous switch only got through some of the
  // six denominations before being interrupted.
  const current = await store.listActiveRecipeProducts();
  const currentByDenom = new Map(current.map((c) => [c.denomination, c]));

  const targetCandidates = await store.listStoredProducts(target);
  const targetByDenom = new Map(
    targetCandidates
      .filter((p) => p.active && p.costUsd !== null)
      .map((p) => [p.diamondsBase, p] as const),
  );

  const repoints: Repoint[] = [];
  const switched: number[] = [];
  const alreadyActive: number[] = [];
  const skipped: number[] = [];

  for (const denomination of BASE_DENOMINATIONS) {
    const currentRow = currentByDenom.get(denomination);
    if (!currentRow) {
      // Nothing sells this denomination today, via either provider — not a
      // gap this switch could create, so there is nothing to report.
      continue;
    }

    const targetRow = targetByDenom.get(denomination);
    if (!targetRow) {
      // Currently in active use, but the target provider isn't ready for it —
      // a real gap. Reported, never silently dropped.
      skipped.push(denomination);
      continue;
    }

    if (currentRow.provider === target && currentRow.providerProductId === targetRow.providerProductId) {
      alreadyActive.push(denomination);
      continue;
    }

    repoints.push({
      denomination,
      fromProvider: currentRow.provider,
      fromProviderProductId: currentRow.providerProductId,
      toProvider: target,
      toProviderProductId: targetRow.providerProductId,
      costUsd: targetRow.costUsd!,
    });
    switched.push(denomination);
  }

  const repointed = repoints.length > 0 ? await store.repointProducts(repoints) : [];

  if (switched.length === 0) {
    // Nothing moved — either already fully on the target, or nothing was
    // ready. Never write `active_provider` on a no-op; the setting should
    // only ever reflect a switch that actually happened.
    if (skipped.length > 0) {
      await alerter.send('critical', `Could not switch to ${target} — not ready for any denomination`, {
        target,
        skipped,
      });
    }
    return { target, switched, alreadyActive, skipped, repointed };
  }

  await setActiveProvider(target, adminUserId);

  if (skipped.length > 0) {
    // A real but partial switch: some denominations are on the target, some
    // are stuck wherever they were. The storefront keeps selling every
    // denomination either way — this is exactly the gap to close by hand.
    await alerter.send('critical', `Switched to ${target}, but ${skipped.length} denomination(s) were not ready`, {
      target,
      switched,
      skipped,
    });
  } else {
    await alerter.send('warn', `Switched active provider to ${target}`, { target, switched });
  }

  return { target, switched, alreadyActive, skipped, repointed };
}
