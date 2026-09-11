/**
 * Drizzle implementation of the engine's `ConversionStore` port.
 *
 * "Storefront order" is decided by `user_agent` being present: it is captured
 * when a browser creates the order and never by the panel. A WhatsApp sale
 * recorded by the owner has no browser, no Pixel cookie and no ad click behind
 * it that Meta could match, so reporting it would only add noise.
 */

import { and, asc, eq, gt, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { ConversionOrder, ConversionStore } from '@levelup/engine';
import type { Database } from '../index.js';
import { orders } from '../schema.js';

/** Paid and then unwound. Reporting these would count refunds as sales. */
const NOT_A_SALE = ['cancelled', 'refund_required'] as const;

export class DrizzleConversionStore implements ConversionStore {
  constructor(private readonly db: Database) {}

  async findUnreported(input: {
    paidAfter: Date;
    maxAttempts: number;
    limit: number;
  }): Promise<ConversionOrder[]> {
    const rows = await this.db
      .select({
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        eventId: orders.eventId,
        comboKey: orders.comboKey,
        priceMxnCents: orders.priceMxnCents,
        paidAt: orders.paidAt,
        playerId: orders.playerId,
        contactEmail: orders.contactEmail,
        contactWhatsapp: orders.contactWhatsapp,
        fbp: orders.fbp,
        fbc: orders.fbc,
        clientIp: orders.clientIp,
        userAgent: orders.userAgent,
        attempts: orders.capiAttempts,
      })
      .from(orders)
      .where(
        and(
          isNotNull(orders.paidAt),
          gt(orders.paidAt, input.paidAfter),
          isNull(orders.capiSentAt),
          lt(orders.capiAttempts, input.maxAttempts),
          isNotNull(orders.userAgent),
          notInArray(orders.status, [...NOT_A_SALE]),
        ),
      )
      .orderBy(asc(orders.paidAt))
      .limit(input.limit);

    return rows.map((r) => ({ ...r, paidAt: r.paidAt!, userAgent: r.userAgent! }));
  }

  async markReported(orderId: string, at: Date): Promise<void> {
    await this.db.update(orders).set({ capiSentAt: at }).where(eq(orders.id, orderId));
  }

  async recordFailedAttempt(orderId: string): Promise<void> {
    await this.db
      .update(orders)
      .set({ capiAttempts: sql`${orders.capiAttempts} + 1` })
      .where(eq(orders.id, orderId));
  }
}
