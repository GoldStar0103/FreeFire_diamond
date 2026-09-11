/**
 * Drizzle implementation of the engine's `CatalogSyncStore` port.
 *
 * Products are keyed by the provider's own id, which is what makes the sync
 * idempotent — running it twice changes nothing, and a product that reappears
 * after being withdrawn is reactivated rather than duplicated.
 */

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { parseUsd } from '@levelup/provider';
import type {
  CatalogSyncStore,
  OrderItemStatus,
  OrderStatus,
  ProductUpsert,
  Repoint,
  RepointOutcome,
  StoredProduct,
} from '@levelup/engine';
import type { Database } from '../index.js';
import { auditLog, baseProducts, comboItems, combos, orderItems, orders } from '../schema.js';
import { toNumericString } from './mapping.js';

/**
 * Item states that provably never charged the wallet: `queued` was never sent,
 * and `failed` is only ever written on a clean rejection or a wallet delta
 * proving nothing moved (see the enum in schema.ts). Everything else may have
 * reached the provider under the old id — `sending` is a call in flight or a
 * crash mid-call, `unknown` and `provider_pending` are awaiting reconciliation
 * against the OLD cost, `succeeded` is history. Rewriting any of those would
 * corrupt the evidence the wallet-delta check and a human reviewer rely on.
 */
const UNSENT_ITEM_STATUSES = ['queued', 'failed'] as const satisfies readonly OrderItemStatus[];

/**
 * Orders nothing will ever dispatch again. Their items are the record of what
 * happened, or of what was never going to — rewriting them only muddies that.
 * `needs_review` is deliberately absent: a human may yet retry its failed
 * items, and a retry must go to an id that still exists.
 */
const CLOSED_ORDER_STATUSES = [
  'completed',
  'cancelled',
  'payment_expired',
  'refund_required',
] as const satisfies readonly OrderStatus[];

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
   * Move recipes and unsent order items from a replaced product to its
   * successor, with an audit row per moved row.
   *
   * One transaction for the whole batch. A recipe moved without its unsent
   * items (or the reverse) would leave a paid order and the combo it was bought
   * from disagreeing about which SKU fulfils it.
   *
   * What is deliberately NOT touched:
   *   - `orders.combo_snapshot`. It is the frozen evidence of what the customer
   *     bought and costed at, and fulfilment reads items, not the snapshot.
   *   - Items that may have reached the provider, and items of closed orders —
   *     see `UNSENT_ITEM_STATUSES` and `CLOSED_ORDER_STATUSES`.
   *
   * The worker runs this under the provider advisory lock, and every dispatch
   * moves an item out of `queued`/`failed` while holding that same lock, so an
   * item cannot be re-pointed in the middle of its own provider call. The row
   * lock taken below backs that up for anyone calling without the lock.
   */
  async repointProducts(repoints: Repoint[]): Promise<RepointOutcome[]> {
    if (repoints.length === 0) return [];

    return this.db.transaction(async (tx) => {
      const providerIds = [
        ...new Set(repoints.flatMap((r) => [r.fromProviderProductId, r.toProviderProductId])),
      ];
      const rows = await tx
        .select({ id: baseProducts.id, providerProductId: baseProducts.providerProductId })
        .from(baseProducts)
        .where(inArray(baseProducts.providerProductId, providerIds));
      const rowIdOf = new Map(rows.map((r) => [r.providerProductId, r.id]));

      const outcomes: RepointOutcome[] = [];

      for (const repoint of repoints) {
        const fromId = rowIdOf.get(repoint.fromProviderProductId);
        const toId = rowIdOf.get(repoint.toProviderProductId);

        if (!toId) {
          // The engine upserts before re-pointing. Reaching here means that
          // contract broke; moving references onto nothing must not proceed.
          throw new Error(
            `Cannot re-point to provider product ${repoint.toProviderProductId}: ` +
              'it is not in base_products. Upsert it first.',
          );
        }

        const common = {
          denomination: repoint.denomination,
          fromProviderProductId: repoint.fromProviderProductId,
          toProviderProductId: repoint.toProviderProductId,
        };

        // ── recipes ──────────────────────────────────────────────────────────
        const recipeRows = fromId
          ? await tx
              .select({
                id: comboItems.id,
                comboId: comboItems.comboId,
                comboKey: combos.key,
                sequence: comboItems.sequence,
              })
              .from(comboItems)
              .innerJoin(combos, eq(combos.id, comboItems.comboId))
              .where(eq(comboItems.baseProductId, fromId))
              .for('update', { of: comboItems })
          : [];

        if (recipeRows.length > 0) {
          await tx
            .update(comboItems)
            .set({ baseProductId: toId })
            .where(
              inArray(
                comboItems.id,
                recipeRows.map((r) => r.id),
              ),
            );

          await tx.insert(auditLog).values(
            recipeRows.map((r) => ({
              adminUserId: null,
              action: 'catalog.recipe_repointed',
              entityType: 'combo_item',
              entityId: r.id,
              detail: { ...common, comboId: r.comboId, comboKey: r.comboKey, sequence: r.sequence },
            })),
          );
        }

        // ── unsent order items ───────────────────────────────────────────────
        // Matched on provider_product_id rather than base_product_id: that is
        // the column fulfilment actually sends, and base_product_id is nullable.
        const itemRows = await tx
          .select({
            id: orderItems.id,
            orderId: orderItems.orderId,
            orderNumber: orders.orderNumber,
            sequence: orderItems.sequence,
            status: orderItems.status,
            costUsd: orderItems.costUsd,
          })
          .from(orderItems)
          .innerJoin(orders, eq(orders.id, orderItems.orderId))
          .where(
            and(
              eq(orderItems.providerProductId, repoint.fromProviderProductId),
              inArray(orderItems.status, [...UNSENT_ITEM_STATUSES]),
              notInArray(orders.status, [...CLOSED_ORDER_STATUSES]),
            ),
          )
          .for('update', { of: orderItems });

        let movedItems = 0;
        if (itemRows.length > 0) {
          const newCost = toNumericString(repoint.costUsd);

          // The status guard is repeated on the write. Under READ COMMITTED
          // the row lock above already re-checks it, but this statement is the
          // one that must never rewrite a dispatched item, so it says so itself.
          const moved = await tx
            .update(orderItems)
            .set({
              providerProductId: repoint.toProviderProductId,
              baseProductId: toId,
              costUsd: newCost,
            })
            .where(
              and(
                inArray(
                  orderItems.id,
                  itemRows.map((r) => r.id),
                ),
                inArray(orderItems.status, [...UNSENT_ITEM_STATUSES]),
              ),
            )
            .returning({ id: orderItems.id });

          const movedIds = new Set(moved.map((m) => m.id));
          movedItems = movedIds.size;

          const audited = itemRows.filter((r) => movedIds.has(r.id));
          if (audited.length > 0) {
            await tx.insert(auditLog).values(
              audited.map((r) => ({
                adminUserId: null,
                action: 'catalog.order_item_repointed',
                entityType: 'order_item',
                entityId: r.id,
                detail: {
                  ...common,
                  orderId: r.orderId,
                  orderNumber: r.orderNumber,
                  sequence: r.sequence,
                  itemStatus: r.status,
                  previousCostUsd: r.costUsd,
                  currentCostUsd: newCost,
                },
              })),
            );
          }
        }

        outcomes.push({
          ...common,
          costUsd: repoint.costUsd,
          recipeItems: recipeRows.length,
          orderItems: movedItems,
        });
      }

      return outcomes;
    });
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
