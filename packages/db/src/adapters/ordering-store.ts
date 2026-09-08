/**
 * Drizzle implementation of the engine's `OrderingStore` port.
 *
 * `persist` is the one place in the system that writes an order, its items and
 * its payment. All three go in a single transaction: an order with no items is
 * invisible to the fulfilment worker, and items with no payment row would let
 * an unpaid order be marked paid by accident.
 */

import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { parseUsd } from '@levelup/provider';
import type { ComboForOrder, NewOrder, OrderingStore, RecipeEntry } from '@levelup/engine';
import { defaultOrderNumber } from '@levelup/engine';
import type { Database } from '../index.js';
import { baseProducts, campaigns, comboItems, combos, orderItems, orders, payments } from '../schema.js';
import { toNumericString } from './mapping.js';

/** Orders that no longer count against a per-player cap. */
const RELEASES_CAP = ['cancelled'] as const;

/** Postgres unique-violation. Retried for order numbers, which are random. */
const UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;

export class DrizzleOrderingStore implements OrderingStore {
  constructor(private readonly db: Database) {}

  async findComboForOrder(comboKey: string): Promise<ComboForOrder | null> {
    const [row] = await this.db
      .select({
        id: combos.id,
        key: combos.key,
        name: combos.name,
        priceMxnCents: combos.priceMxnCents,
        advertisedDiamonds: combos.advertisedDiamonds,
        maxPerPlayer: combos.maxPerPlayer,
        active: combos.active,
        startsAt: combos.startsAt,
        endsAt: combos.endsAt,
        campaignName: campaigns.name,
        campaignActive: campaigns.active,
        campaignStartsAt: campaigns.startsAt,
        campaignEndsAt: campaigns.endsAt,
      })
      .from(combos)
      .innerJoin(campaigns, eq(campaigns.id, combos.campaignId))
      .where(eq(combos.key, comboKey))
      .limit(1);

    if (!row) return null;

    const recipe = await this.db
      .select({
        sequence: comboItems.sequence,
        baseProductId: baseProducts.id,
        providerProductId: baseProducts.providerProductId,
        endpointKind: baseProducts.endpointKind,
        diamondsBase: baseProducts.diamondsBase,
        costUsd: baseProducts.costUsd,
        active: baseProducts.active,
        requiresServerId: baseProducts.requiresServerId,
      })
      .from(comboItems)
      .innerJoin(baseProducts, eq(baseProducts.id, comboItems.baseProductId))
      .where(eq(comboItems.comboId, row.id))
      .orderBy(asc(comboItems.sequence));

    const now = new Date();
    // A campaign whose window has closed makes its combos unavailable too —
    // that is how the monthly flyer rotation actually retires a promo.
    const campaignInWindow =
      (!row.campaignStartsAt || now >= row.campaignStartsAt) &&
      (!row.campaignEndsAt || now <= row.campaignEndsAt);

    return {
      id: row.id,
      key: row.key,
      name: row.name,
      campaignName: row.campaignName,
      priceMxnCents: row.priceMxnCents,
      advertisedDiamonds: row.advertisedDiamonds,
      maxPerPlayer: row.maxPerPlayer,
      active: row.active,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      campaignActive: row.campaignActive && campaignInWindow,
      recipe: recipe.map(
        (r): RecipeEntry => ({
          sequence: r.sequence,
          baseProductId: r.baseProductId,
          providerProductId: r.providerProductId,
          endpointKind: r.endpointKind,
          diamondsBase: r.diamondsBase,
          costUsd: r.costUsd === null ? null : parseUsd(r.costUsd),
          active: r.active,
          requiresServerId: r.requiresServerId,
        }),
      ),
    };
  }

  async countPlayerOrders(playerId: string, comboKey: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<string>`COUNT(*)::text` })
      .from(orders)
      .where(
        and(
          eq(orders.playerId, playerId),
          eq(orders.comboKey, comboKey),
          notInArray(orders.status, [...RELEASES_CAP]),
        ),
      );

    return Number(row?.count ?? 0);
  }

  async persist(order: NewOrder): Promise<{ id: string; orderNumber: string }> {
    // Order numbers carry a random tail, so a collision is rare but possible.
    // Retrying is cheaper than coordinating a counter across workers.
    for (let attempt = 0; attempt < 5; attempt++) {
      const orderNumber = attempt === 0 ? order.orderNumber : defaultOrderNumber();

      try {
        return await this.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(orders)
            .values({
              orderNumber,
              playerId: order.playerId,
              playerNickname: order.playerNickname,
              serverId: order.serverId,
              contactEmail: order.contactEmail,
              contactWhatsapp: order.contactWhatsapp,
              comboId: order.comboId,
              comboKey: order.comboKey,
              comboSnapshot: order.comboSnapshot,
              priceMxnCents: order.priceMxnCents,
              status: 'pending_payment',
              fbp: order.tracking?.fbp ?? null,
              fbc: order.tracking?.fbc ?? null,
              clientIp: order.tracking?.clientIp ?? null,
              userAgent: order.tracking?.userAgent ?? null,
            })
            .returning({ id: orders.id, orderNumber: orders.orderNumber });

          if (!created) throw new Error('Order insert returned no row');

          await tx.insert(orderItems).values(
            order.items.map((item) => ({
              orderId: created.id,
              sequence: item.sequence,
              baseProductId: item.baseProductId,
              providerProductId: item.providerProductId,
              diamondsBase: item.diamondsBase,
              costUsd: toNumericString(item.costUsd),
              status: 'queued' as const,
            })),
          );

          await tx.insert(payments).values({
            orderId: created.id,
            method: order.paymentMethod,
            status: 'pending',
            amountExpectedCents: order.priceMxnCents,
          });

          return created;
        });
      } catch (err) {
        // Only an order-number clash is worth retrying. The Mega Oferta partial
        // unique index also raises 23505, and that must surface to the caller —
        // silently retrying it would defeat the cap.
        if (isUniqueViolation(err) && String(err).includes('orders_number_idx')) continue;
        throw err;
      }
    }

    throw new Error('Could not allocate a unique order number after 5 attempts');
  }
}
