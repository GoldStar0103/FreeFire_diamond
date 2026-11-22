/**
 * Public read models for the RocketPass item storefront.
 *
 * Same boundary `storefront-queries.ts` documents for combos: cost/ARS
 * figures never cross into these shapes, only the admin-typed MXN sale price
 * a customer actually sees (`itemCatalog.priceMxnCents`) — no pricing
 * settings to pass in anymore, now that it's a manual per-item number
 * instead of a computed flat-markup figure.
 */

import { and, asc, eq, isNotNull } from 'drizzle-orm';
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

/** Everything sellable right now — active, still reported available by RocketPass, AND priced. */
export async function listStorefrontItems(db: Database): Promise<StorefrontItem[]> {
  const rows = await db
    .select({
      id: itemCatalog.id,
      sku: itemCatalog.sku,
      displayName: itemCatalog.displayName,
      kind: itemCatalog.kind,
      priceMxnCents: itemCatalog.priceMxnCents,
      maxQuantity: itemCatalog.maxQuantity,
    })
    .from(itemCatalog)
    .where(
      and(
        eq(itemCatalog.active, true),
        eq(itemCatalog.rocketpassAvailable, true),
        isNotNull(itemCatalog.priceMxnCents),
      ),
    )
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
    // Safe: the `isNotNull` filter above guarantees this.
    salePriceMxnCents: r.priceMxnCents!,
    maxQuantity: r.maxQuantity,
    stockByRegion: stockById.get(r.id) ?? {},
  }));
}

/** One item, for its buy page. Null when it is not currently sellable (inactive, unavailable, or not priced yet). */
export async function getStorefrontItem(db: Database, sku: string): Promise<StorefrontItem | null> {
  const [row] = await db
    .select({
      id: itemCatalog.id,
      sku: itemCatalog.sku,
      displayName: itemCatalog.displayName,
      kind: itemCatalog.kind,
      priceMxnCents: itemCatalog.priceMxnCents,
      maxQuantity: itemCatalog.maxQuantity,
      active: itemCatalog.active,
      rocketpassAvailable: itemCatalog.rocketpassAvailable,
    })
    .from(itemCatalog)
    .where(eq(itemCatalog.sku, sku))
    .limit(1);

  if (!row || !row.active || !row.rocketpassAvailable || row.priceMxnCents == null) return null;

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
    salePriceMxnCents: row.priceMxnCents,
    maxQuantity: row.maxQuantity,
    stockByRegion,
  };
}
