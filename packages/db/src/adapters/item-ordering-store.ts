/**
 * Drizzle implementation of the engine's `ItemOrderingStore` port.
 *
 * Mirrors `ordering-store.ts`'s `persist` exactly: order, item detail, and
 * payment all go in one transaction — an order with no `item_order_details`
 * row is invisible to the worker's item-fulfillment loop, and an item with
 * no payment row would let an unpaid order be marked paid by accident.
 *
 * `orders.combo_snapshot` is `NOT NULL` with no item-order carve-out in the
 * schema, so an item order freezes its own `ItemSnapshot` into that column
 * under the same `{ name, advertisedDiamonds }` shape the combo read models
 * (`storefront-queries.ts`) already fall back to — `advertisedDiamonds: 0`
 * reads correctly everywhere that already treats a missing value as "not a
 * diamond order" rather than needing every one of those call sites to learn
 * about `order_type` just to show a name.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { ItemForOrder, ItemOrderingStore, NewItemOrder } from '@levelup/engine';
import { defaultOrderNumber, paymentTtlMsFor } from '@levelup/engine';
import type { Database } from '../index.js';
import { itemCatalog, itemOrderDetails, itemStock, notifications, orders, payments } from '../schema.js';

const UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;

export class DrizzleItemOrderingStore implements ItemOrderingStore {
  constructor(private readonly db: Database) {}

  async findItemForOrder(sku: string): Promise<ItemForOrder | null> {
    const [row] = await this.db
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

    if (!row) return null;

    const stockRows =
      row.kind === 'gift'
        ? await this.db
            .select({ region: itemStock.region, quantity: itemStock.quantity })
            .from(itemStock)
            .where(eq(itemStock.itemCatalogId, row.id))
        : [];

    const stockByRegion: Record<string, number> = {};
    for (const s of stockRows) stockByRegion[s.region] = s.quantity;

    return {
      id: row.id,
      sku: row.sku,
      displayName: row.displayName,
      kind: row.kind,
      priceArs: Number(row.priceArs),
      maxQuantity: row.maxQuantity,
      active: row.active,
      rocketpassAvailable: row.rocketpassAvailable,
      stockByRegion,
    };
  }

  async persist(order: NewItemOrder): Promise<{ id: string; orderNumber: string }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const orderNumber = attempt === 0 ? order.orderNumber : defaultOrderNumber();

      try {
        return await this.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(orders)
            .values({
              orderNumber,
              playerId: order.playerId,
              playerProfileId: order.playerProfileId ?? null,
              playerNickname: order.playerNickname,
              contactWhatsapp: order.contactWhatsapp,
              orderType: 'item',
              comboId: null,
              comboKey: null,
              comboSnapshot: { name: order.item.itemName, advertisedDiamonds: 0 },
              priceMxnCents: order.priceMxnCents,
              status: 'pending_payment',
              fbp: order.tracking?.fbp ?? null,
              fbc: order.tracking?.fbc ?? null,
              clientIp: order.tracking?.clientIp ?? null,
              userAgent: order.tracking?.userAgent ?? null,
            })
            .returning({ id: orders.id, orderNumber: orders.orderNumber });

          if (!created) throw new Error('Order insert returned no row');

          await tx.insert(itemOrderDetails).values({
            orderId: created.id,
            itemSku: order.item.itemSku,
            itemNameSnapshot: order.item.itemName,
            quantity: order.item.quantity,
            region: order.item.region,
            unitPriceSnapshotCents: order.item.unitPriceMxnCents,
            unitCostCentsSnapshot: order.item.unitCostMxnCents,
            fulfillmentStatus: 'pending',
          });

          await tx.insert(payments).values({
            orderId: created.id,
            method: order.paymentMethod,
            status: 'pending',
            amountExpectedCents: order.priceMxnCents,
            expiresAt: new Date(Date.now() + paymentTtlMsFor(order.paymentMethod)),
          });

          if (order.playerProfileId) {
            await tx
              .insert(notifications)
              .values({
                playerProfileId: order.playerProfileId,
                type: 'order_created',
                title: 'Recibimos tu pedido',
                message: `Pedido ${created.orderNumber} creado. Te avisamos en cuanto confirmemos tu pago.`,
                targetUrl: `/pedido/${created.orderNumber}?id=${encodeURIComponent(order.playerId)}`,
                orderId: created.id,
              })
              .onConflictDoNothing({ target: [notifications.orderId, notifications.type] });
          }

          return created;
        });
      } catch (err) {
        if (isUniqueViolation(err) && String(err).includes('orders_number_idx')) continue;
        throw err;
      }
    }

    throw new Error('Could not allocate a unique order number after 5 attempts');
  }
}

/**
 * The item-order equivalent of `storefront-queries.ts`'s `findResumableOrder`
 * — same reasoning, same exclusions (only a genuinely untouched `'pending'`
 * payment counts), keyed by `(playerId, sku)` instead of `(playerId, comboKey)`
 * since an item order has no combo key.
 */
export interface ResumableItemOrder {
  id: string;
  orderNumber: string;
  priceMxnCents: number;
  itemName: string;
  contactWhatsapp: string | null;
  paymentMethod: string | null;
  gateway: string | null;
}

export async function findResumableItemOrder(
  db: Database,
  input: { playerId: string; sku: string },
): Promise<ResumableItemOrder | null> {
  const [row] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      priceMxnCents: orders.priceMxnCents,
      contactWhatsapp: orders.contactWhatsapp,
      itemSku: itemOrderDetails.itemSku,
      itemNameSnapshot: itemOrderDetails.itemNameSnapshot,
    })
    .from(orders)
    .innerJoin(itemOrderDetails, eq(itemOrderDetails.orderId, orders.id))
    .where(
      and(
        eq(orders.playerId, input.playerId.trim()),
        eq(orders.orderType, 'item'),
        eq(itemOrderDetails.itemSku, input.sku),
        eq(orders.status, 'pending_payment'),
      ),
    )
    .limit(1);

  if (!row) return null;

  const [payment] = await db
    .select({
      method: payments.method,
      status: payments.status,
      gateway: payments.gateway,
      expiresAt: payments.expiresAt,
    })
    .from(payments)
    .where(eq(payments.orderId, row.id))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  if (!payment || payment.status !== 'pending') return null;
  if (payment.expiresAt && payment.expiresAt < new Date()) return null;

  return {
    id: row.id,
    orderNumber: row.orderNumber,
    priceMxnCents: row.priceMxnCents,
    itemName: row.itemNameSnapshot,
    contactWhatsapp: row.contactWhatsapp,
    paymentMethod: payment.method,
    gateway: payment.gateway,
  };
}
