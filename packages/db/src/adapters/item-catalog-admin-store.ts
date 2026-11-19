/**
 * Admin-facing reads/writes over the RocketPass item catalog.
 *
 * Separate from `rocketpass-catalog-store.ts`, which is the worker's
 * sync-only writer (`upsertCatalog`) — this is additive, never touched by
 * the sync loop. The one field the sync loop and this store both care about,
 * `displayName`, is written here on purpose and never by the sync (see that
 * file's own doc comment on why).
 */

import { asc, eq } from 'drizzle-orm';
import type { Database } from '../index.js';
import { itemCatalog, itemStock } from '../schema.js';

export interface AdminItemRow {
  sku: string;
  displayName: string;
  rocketpassName: string;
  kind: 'gift' | 'membership';
  priceArs: number;
  maxQuantity: number;
  active: boolean;
  rocketpassAvailable: boolean;
  lastSyncedAt: Date | null;
  /** Region code -> quantity. Empty for `kind === 'membership'`. */
  stockByRegion: Record<string, number>;
}

export class DrizzleItemCatalogAdminStore {
  constructor(private readonly db: Database) {}

  async listItemsForAdmin(): Promise<AdminItemRow[]> {
    const rows = await this.db
      .select({
        id: itemCatalog.id,
        sku: itemCatalog.sku,
        displayName: itemCatalog.displayName,
        rocketpassName: itemCatalog.rocketpassName,
        kind: itemCatalog.kind,
        priceArs: itemCatalog.priceArs,
        maxQuantity: itemCatalog.maxQuantity,
        active: itemCatalog.active,
        rocketpassAvailable: itemCatalog.rocketpassAvailable,
        lastSyncedAt: itemCatalog.lastSyncedAt,
      })
      .from(itemCatalog)
      .orderBy(asc(itemCatalog.displayName));

    if (rows.length === 0) return [];

    const stockRows = await this.db
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
      rocketpassName: r.rocketpassName,
      kind: r.kind,
      priceArs: Number(r.priceArs),
      maxQuantity: r.maxQuantity,
      active: r.active,
      rocketpassAvailable: r.rocketpassAvailable,
      lastSyncedAt: r.lastSyncedAt,
      stockByRegion: stockById.get(r.id) ?? {},
    }));
  }

  /** `adminUserId` is accepted for parity with every other admin write in this
   *  codebase, even though `item_catalog` has no audit column of its own yet —
   *  kept so one is easy to add later without touching every call site. */
  async setItemActive(sku: string, active: boolean, _adminUserId: string): Promise<void> {
    await this.db.update(itemCatalog).set({ active, updatedAt: new Date() }).where(eq(itemCatalog.sku, sku));
  }

  async setItemDisplayName(sku: string, displayName: string, _adminUserId: string): Promise<void> {
    await this.db
      .update(itemCatalog)
      .set({ displayName, updatedAt: new Date() })
      .where(eq(itemCatalog.sku, sku));
  }
}
