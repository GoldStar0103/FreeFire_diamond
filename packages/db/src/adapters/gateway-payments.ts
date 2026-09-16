/**
 * Card-gateway bookkeeping: which Stripe session belongs to which order, and
 * which webhook deliveries have already been acted on.
 *
 * The decision about what a payment *means* is not made here — that is
 * `settleGatewayCharge` in the engine, which goes through the same
 * `approvePayment` a human tap does. This file only records and looks up.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../index.js';
import { orders, paymentEvents, payments } from '../schema.js';

/**
 * Link a freshly created gateway session to the order's payment row.
 *
 * Guarded on `pending`: a session is only ever attached to a payment nobody
 * has acted on yet. The deadline moves to the session's own, plus grace, so
 * the expiry sweep retires an abandoned card checkout in about an hour
 * instead of holding a Mega Oferta slot for the two days a transfer gets.
 */
export async function attachGatewayCharge(
  db: Database,
  input: { orderId: string; gateway: string; gatewayChargeId: string; expiresAt: Date | null },
): Promise<boolean> {
  const updated = await db
    .update(payments)
    .set({
      gateway: input.gateway,
      gatewayChargeId: input.gatewayChargeId,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    })
    .where(and(eq(payments.orderId, input.orderId), eq(payments.status, 'pending')))
    .returning({ id: payments.id });

  return updated.length > 0;
}

export interface GatewayPayment {
  paymentId: string;
  orderId: string;
  orderNumber: string;
  playerId: string;
  comboKey: string;
  /** From the combo snapshot taken at order creation — for the card-sale Telegram alert. */
  comboName: string;
  priceMxnCents: number;
  paymentStatus: string;
  orderStatus: string;
  expiresAt: Date | null;
}

/** The payment a gateway session belongs to. The session id is the only key trusted. */
export async function findGatewayPayment(
  db: Database,
  gateway: string,
  gatewayChargeId: string,
): Promise<GatewayPayment | null> {
  const [row] = await db
    .select({
      paymentId: payments.id,
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      playerId: orders.playerId,
      comboKey: orders.comboKey,
      comboSnapshot: orders.comboSnapshot,
      priceMxnCents: orders.priceMxnCents,
      paymentStatus: payments.status,
      orderStatus: orders.status,
      expiresAt: payments.expiresAt,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(and(eq(payments.gateway, gateway), eq(payments.gatewayChargeId, gatewayChargeId)))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  if (!row) return null;
  const { comboSnapshot, ...rest } = row;
  const snapshot = comboSnapshot as { name?: string };
  return { ...rest, comboName: snapshot.name ?? 'Recarga' };
}

/**
 * Push a pending payment's deadline out — used when an OXXO voucher is issued.
 *
 * The voucher is payable for days; the Checkout session it came from expired
 * in an hour. Without this the sweep would expire the order while the customer
 * was still walking to the OXXO, and their payment would land on a dead order.
 * Only ever extends, never shortens.
 */
export async function extendPaymentDeadline(
  db: Database,
  paymentId: string,
  until: Date,
): Promise<void> {
  const [row] = await db
    .select({ expiresAt: payments.expiresAt, status: payments.status })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!row || row.status !== 'pending') return;
  if (row.expiresAt && row.expiresAt >= until) return;

  await db.update(payments).set({ expiresAt: until }).where(eq(payments.id, paymentId));
}

/**
 * Log a webhook delivery, and say whether it has already been acted on.
 *
 * The unique index on (gateway, event id) is the dedupe. But a delivery that
 * was *recorded* and then failed half-way must be retried when Stripe sends it
 * again — so a duplicate is only "already handled" once `processed_at` is set.
 * Recording first and treating every duplicate as done would turn one database
 * blip into a customer who paid and never gets their diamonds.
 */
export async function recordPaymentEvent(
  db: Database,
  input: { gateway: string; eventId: string; eventType: string; payload: unknown },
): Promise<{ id: string; alreadyProcessed: boolean }> {
  await db
    .insert(paymentEvents)
    .values({
      gateway: input.gateway,
      gatewayEventId: input.eventId,
      eventType: input.eventType,
      payload: input.payload as object,
    })
    .onConflictDoNothing({ target: [paymentEvents.gateway, paymentEvents.gatewayEventId] });

  const [row] = await db
    .select({ id: paymentEvents.id, processedAt: paymentEvents.processedAt })
    .from(paymentEvents)
    .where(and(eq(paymentEvents.gateway, input.gateway), eq(paymentEvents.gatewayEventId, input.eventId)))
    .limit(1);

  if (!row) throw new Error(`payment event ${input.gateway}/${input.eventId} vanished after insert`);
  return { id: row.id, alreadyProcessed: row.processedAt !== null };
}

export async function markPaymentEventProcessed(
  db: Database,
  eventRowId: string,
  paymentId: string | null,
): Promise<void> {
  await db
    .update(paymentEvents)
    .set({ processedAt: new Date(), ...(paymentId ? { paymentId } : {}) })
    .where(and(eq(paymentEvents.id, eventRowId), isNull(paymentEvents.processedAt)));
}
