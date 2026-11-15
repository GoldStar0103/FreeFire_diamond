/**
 * Drizzle implementation of the engine's `RocketPassCatalogStore` port.
 *
 * `displayName` is never written here on an update — it is Jose's own
 * marketing name (admin-editable in the panel), kept deliberately separate
 * from `rocketpassName` so a sync can never overwrite what he called a SKU.
 * It is only ever set once, from `rocketpassName`, the first time a SKU is
 * seen.
 */

import type { RocketPassCatalogStore, SyncedCatalogItem } from '@levelup/engine';
import type { Database } from '../index.js';
import { itemCatalog, itemStock } from '../schema.js';

export class DrizzleRocketPassCatalogStore implements RocketPassCatalogStore {
  constructor(private readonly db: Database) {}

  async upsertCatalog(items: SyncedCatalogItem[], syncedAt: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const item of items) {
        const [row] = await tx
          .insert(itemCatalog)
          .values({
            sku: item.sku,
            displayName: item.name,
            rocketpassName: item.name,
            kind: item.kind,
            priceArs: item.priceArs.toFixed(2),
            maxQuantity: item.maxQuantity,
            rocketpassAvailable: item.available,
            lastSyncedAt: syncedAt,
          })
          .onConflictDoUpdate({
            target: itemCatalog.sku,
            set: {
              rocketpassName: item.name,
              kind: item.kind,
              priceArs: item.priceArs.toFixed(2),
              maxQuantity: item.maxQuantity,
              rocketpassAvailable: item.available,
              lastSyncedAt: syncedAt,
              updatedAt: syncedAt,
            },
          })
          .returning({ id: itemCatalog.id });
        if (!row) continue;

        if (item.stockByRegion) {
          for (const [region, quantity] of Object.entries(item.stockByRegion)) {
            await tx
              .insert(itemStock)
              .values({ itemCatalogId: row.id, region, quantity, updatedAt: syncedAt })
              .onConflictDoUpdate({
                target: [itemStock.itemCatalogId, itemStock.region],
                set: { quantity, updatedAt: syncedAt },
              });
          }
        }
      }
    });
  }
}
