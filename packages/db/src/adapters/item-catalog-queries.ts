/**
 * Public read models for the RocketPass item storefront.
 *
 * Same boundary `storefront-queries.ts` documents for combos: cost/ARS
 * figures never cross into these shapes, only the computed MXN sale price a
 * customer actually sees. Computing that price needs the admin-set ARS rate
 * and markup percent (`payment-settings.ts`), so both queries take them as
 * parameters rather than reading settings themselves — keeps this file a
 * pure read model, same as its combo counterpart.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../index.js';
import { itemCatalog, itemStock } from '../schema.js';

export interface StorefrontItem {
  sku: string;
  displayName: string;
  kind: 'gift' | 'membership';
  salePriceMxnCents: number;
  maxQuantity: number;
  /** Region code -> quantity. Empty for `kind === 'membership'`. */
  stockByRegion: Record<string, number>;
}

function salePriceMxnCents(priceArs: string, arsRate: number, markupPercent: number): number {
  const costCents = Math.round(Number(priceArs) * arsRate * 100);
  return Math.round(costCents * (1 + markupPercent / 100));
}

/** Everything sellable right now — active AND still reported available by RocketPass. */
export async function listStorefrontItems(
  db: Database,
  pricing: { arsRate: number; markupPercent: number },
): Promise<StorefrontItem[]> {
  const rows = await db
    .select({
      id: itemCatalog.id,
      sku: itemCatalog.sku,
      displayName: itemCatalog.displayName,
      kind: itemCatalog.kind,
      priceArs: itemCatalog.priceArs,
      maxQuantity: itemCatalog.maxQuantity,
    })
    .from(itemCatalog)
    .where(and(eq(itemCatalog.active, true), eq(itemCatalog.rocketpassAvailable, true)))
    .orderBy(asc(itemCatalog.displayName));

  if (rows.length === 0) return [];

  const stockRows = await db
    .select({ itemCatalogId: itemStock.itemCatalogId, region: itemStock.region, quantity: itemStock.quantity })
    .from(itemStock);

  const stockById = new Map<string, Record<string, number>>();
  for (const s of stockRows) {
    const existing = stockById.get(s.itemCatalogId) ?? {};
    existing[s.region] = s.quantity;
    stockById.set(s.itemCatalogId, existing);
  }

  return rows.map((r) => ({
    sku: r.sku,
    displayName: r.displayName,
    kind: r.kind,
    salePriceMxnCents: salePriceMxnCents(r.priceArs, pricing.arsRate, pricing.markupPercent),
    maxQuantity: r.maxQuantity,
    stockByRegion: stockById.get(r.id) ?? {},
  }));
}

/** One item, for its buy page. Null when it is not currently sellable. */
export async function getStorefrontItem(
  db: Database,
  sku: string,
  pricing: { arsRate: number; markupPercent: number },
): Promise<StorefrontItem | null> {
  const [row] = await db
    .select({
      id: itemCatalog.id,
      sku: itemCatalog.sku,
      displayName: itemCatalog.displayName,
      kind: itemCatalog.kind,
      priceArs: itemCatalog.priceArs,
      maxQuantity: itemCatalog.maxQuantity,
      active: itemCatalog.active,
      rocketpassAvailable: itemCatalog.rocketpassAvailable,
    })
    .from(itemCatalog)
    .where(eq(itemCatalog.sku, sku))
    .limit(1);

  if (!row || !row.active || !row.rocketpassAvailable) return null;

  const stockRows =
    row.kind === 'gift'
      ? await db
          .select({ region: itemStock.region, quantity: itemStock.quantity })
          .from(itemStock)
          .where(eq(itemStock.itemCatalogId, row.id))
      : [];

  const stockByRegion: Record<string, number> = {};
  for (const s of stockRows) stockByRegion[s.region] = s.quantity;

  return {
    sku: row.sku,
    displayName: row.displayName,
    kind: row.kind,
    salePriceMxnCents: salePriceMxnCents(row.priceArs, pricing.arsRate, pricing.markupPercent),
    maxQuantity: row.maxQuantity,
    stockByRegion,
  };
}
