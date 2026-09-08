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
 */

import type { ProviderProduct, TopupProvider, UsdTenK } from '@levelup/provider';
import { mapDenominations } from '@levelup/provider';

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

export interface CatalogSyncStore {
  listStoredProducts(): Promise<StoredProduct[]>;
  upsertProducts(products: ProductUpsert[]): Promise<void>;
  deactivateProducts(providerProductIds: string[]): Promise<void>;
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

export interface CatalogSyncResult {
  /** Denominations now mapped to a usable product. */
  mapped: number[];
  /** Denominations with no provider product at all — combos using them break. */
  missing: number[];
  added: string[];
  updated: string[];
  deactivated: string[];
  costChanges: CostChange[];
  /** Products found but unusable, with the reason. */
  skipped: Array<{ providerProductId: string; name: string; reason: string }>;
  /** True when no denomination resolved to a direct top-up. */
  blocked: boolean;
}

export interface CatalogSyncDeps {
  store: CatalogSyncStore;
  provider: TopupProvider;
  /** Report a cost move of at least this fraction (0.02 = 2%). */
  costChangeThreshold?: number;
}

export async function syncCatalog(deps: CatalogSyncDeps): Promise<CatalogSyncResult> {
  const threshold = deps.costChangeThreshold ?? 0.02;

  const catalog = await deps.provider.listFreeFireCatalog();
  const stored = await deps.store.listStoredProducts();
  const byProviderId = new Map(stored.map((p) => [p.providerProductId, p]));

  const matches = mapDenominations(catalog);
  const skipped: CatalogSyncResult['skipped'] = [];
  const upserts: ProductUpsert[] = [];
  const mapped: number[] = [];
  const missing: number[] = [];

  for (const match of matches) {
    if (!match.chosen) {
      missing.push(match.denomination);
      continue;
    }

    const product = match.chosen;

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

  if (upserts.length > 0) await deps.store.upsertProducts(upserts);

  // Anything previously active that the provider no longer offers. Deactivated,
  // never deleted — order items and combo recipes still point at these rows.
  const stillOffered = new Set(upserts.map((u) => u.providerProductId));
  const deactivated = stored
    .filter((p) => p.active && !stillOffered.has(p.providerProductId))
    .map((p) => p.providerProductId);

  if (deactivated.length > 0) await deps.store.deactivateProducts(deactivated);

  return {
    mapped,
    missing,
    added,
    updated,
    deactivated,
    costChanges,
    skipped,
    blocked: mapped.length === 0,
  };
}

/** One-line summary for the console and the Telegram alert. */
export function summariseSync(result: CatalogSyncResult): string {
  const parts = [
    `${result.mapped.length}/6 denominations mapped`,
    `${result.added.length} added`,
    `${result.updated.length} updated`,
  ];
  if (result.deactivated.length) parts.push(`${result.deactivated.length} deactivated`);
  if (result.costChanges.length) parts.push(`${result.costChanges.length} cost change(s)`);
  if (result.missing.length) parts.push(`MISSING: ${result.missing.join(', ')}`);
  return parts.join(', ');
}
