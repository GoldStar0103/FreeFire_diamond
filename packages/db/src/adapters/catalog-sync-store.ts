/**
 * Drizzle implementation of the engine's `CatalogSyncStore` port.
 *
 * Products are keyed by the provider's own id, which is what makes the sync
 * idempotent — running it twice changes nothing, and a product that reappears
 * after being withdrawn is reactivated rather than duplicated.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import { parseUsd } from '@levelup/provider';
import type { CatalogSyncStore, ProductUpsert, StoredProduct } from '@levelup/engine';
import type { Database } from '../index.js';
import { baseProducts } from '../schema.js';
import { toNumericString } from './mapping.js';

export class DrizzleCatalogSyncStore implements CatalogSyncStore {
  constructor(private readonly db: Database) {}

  async listStoredProducts(): Promise<StoredProduct[]> {
    const rows = await this.db
      .select({
        id: baseProducts.id,
        providerProductId: baseProducts.providerProductId,
        endpointKind: baseProducts.endpointKind,
        diamondsBase: baseProducts.diamondsBase,
        costUsd: baseProducts.costUsd,
        active: baseProducts.active,
      })
      .from(baseProducts);

    return rows.map((r) => ({
      ...r,
      costUsd: r.costUsd === null ? null : parseUsd(r.costUsd),
    }));
  }

  async upsertProducts(products: ProductUpsert[]): Promise<void> {
    if (products.length === 0) return;
    const syncedAt = new Date();

    await this.db
      .insert(baseProducts)
      .values(
        products.map((p) => ({
          providerProductId: p.providerProductId,
          endpointKind: p.endpointKind,
          sku: p.sku,
          name: p.name,
          diamondsBase: p.diamondsBase,
          costUsd: toNumericString(p.costUsd),
          requiresServerId: p.requiresServerId,
          canValidate: p.canValidate,
          active: true,
          lastSyncedAt: syncedAt,
        })),
      )
      .onConflictDoUpdate({
        target: baseProducts.providerProductId,
        set: {
          // `excluded` is the row we tried to insert. A product the provider
          // has started offering again comes back active automatically.
          endpointKind: sql`excluded.endpoint_kind`,
          sku: sql`excluded.sku`,
          name: sql`excluded.name`,
          diamondsBase: sql`excluded.diamonds_base`,
          costUsd: sql`excluded.cost_usd`,
          requiresServerId: sql`excluded.requires_server_id`,
          canValidate: sql`excluded.can_validate`,
          active: sql`excluded.active`,
          lastSyncedAt: sql`excluded.last_synced_at`,
        },
      });
  }

  async deactivateProducts(providerProductIds: string[]): Promise<void> {
    if (providerProductIds.length === 0) return;

    // Deactivate, never delete: combo recipes and historical order items still
    // reference these rows, and past orders must stay readable.
    await this.db
      .update(baseProducts)
      .set({ active: false })
      .where(inArray(baseProducts.providerProductId, providerProductIds));
  }

  /**
   * Combos whose recipes are incomplete.
   *
   * The seed skips recipe rows for denominations that had no product yet, so
   * after a first sync it must be re-run to create them. This reports which
   * combos are still short, rather than letting them fail at checkout.
   */
  async findIncompleteRecipes(): Promise<Array<{ comboKey: string; name: string; items: number }>> {
    const rows = await this.db.execute<{ key: string; name: string; items: string }>(sql`
      SELECT c.key, c.name, COUNT(ci.id)::text AS items
        FROM combos c
   LEFT JOIN combo_items ci ON ci.combo_id = c.id
    GROUP BY c.id, c.key, c.name
      HAVING COUNT(ci.id) = 0
    ORDER BY c.key
    `);

    return rows.map((r) => ({ comboKey: r.key, name: r.name, items: Number(r.items) }));
  }
}
