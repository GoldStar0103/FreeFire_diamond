/**
 * Card-gateway bookkeeping: which Stripe session belongs to which order, and
 * which webhook deliveries have already been acted on.
 *
 * The decision about what a payment *means* is not made here — that is
 * `settleGatewayCharge` in the engine, which goes through the same
 * `approvePayment` a human tap does. This file only records and looks up.
 */

import { and, asc, desc, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import type { Database } from '../index.js';
import { orders, paymentEvents, payments } from '../schema.js';

/**
 * Link a freshly created gateway session to the order's payment row.
 *
 * Guarded on `pending`: a session is only ever attached to a payment nobody
 * has acted on yet. The deadline moves to the session's own, plus grace, so
 * the expiry sweep retires an abandoned card checkout in about an hour
 * instead of holding a Mega Oferta slot for the two days a transfer gets.
 *
 * `method` is optional and only passed when resuming an order whose first
 * attempt used a *different* method (e.g. abandoned OXXO, now paying by
 * card) — see `findResumableOrder`. Omitted on a fresh order's own first
 * attachment, where the method is already exactly what was just recorded.
 */
export async function attachGatewayCharge(
  db: Database,
  input: {
    orderId: string;
    gateway: string;
    gatewayChargeId: string;
    expiresAt: Date | null;
    method?: 'card' | 'oxxo' | 'spei';
  },
): Promise<boolean> {
  const updated = await db
    .update(payments)
    .set({
      gateway: input.gateway,
      gatewayChargeId: input.gatewayChargeId,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.method ? { method: input.method } : {}),
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
  /** Null for an item order (no combo) — see `orders.orderType`. */
  comboKey: string | null;
  /** From the combo snapshot taken at order creation — for the sale Telegram alert. */
  comboName: string;
  priceMxnCents: number;
  paymentStatus: string;
  orderStatus: string;
  expiresAt: Date | null;
  /** 'card' | 'oxxo' | 'spei' for a Stripe-routed payment — which sale alert to send. */
  method: string;
  /** The gateway/charge this order's payment is actually linked to right now, if any. */
  gateway: string | null;
  gatewayChargeId: string | null;
}

const GATEWAY_PAYMENT_COLUMNS = {
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
  method: payments.method,
  gateway: payments.gateway,
  gatewayChargeId: payments.gatewayChargeId,
} as const;

function toGatewayPayment(row: {
  comboSnapshot: unknown;
  [key: string]: unknown;
}): GatewayPayment {
  const { comboSnapshot, ...rest } = row;
  const snapshot = comboSnapshot as { name?: string };
  return { ...rest, comboName: snapshot.name ?? 'Recarga' } as GatewayPayment;
}

/** The payment a gateway session belongs to. The session id is the only key trusted. */
export async function findGatewayPayment(
  db: Database,
  gateway: string,
  gatewayChargeId: string,
): Promise<GatewayPayment | null> {
  const [row] = await db
    .select(GATEWAY_PAYMENT_COLUMNS)
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(and(eq(payments.gateway, gateway), eq(payments.gatewayChargeId, gatewayChargeId)))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  if (!row) return null;
  return toGatewayPayment(row);
}

/**
 * The payment for an order, looked up by order number instead of a gateway
 * charge id.
 *
 * Used as the fallback when a 'paid' gateway report cannot find its payment
 * by `(gateway, gatewayChargeId)` — see `applyGatewayReport`'s own comment on
 * why that link can fail even though the charge itself succeeded. Mercado
 * Pago's `external_reference` (which this app always sets to the order
 * number, and which is never written to by `attachGatewayCharge`'s own,
 * occasionally-losing race) is the one identifier immune to that failure
 * mode.
 */
export async function findPaymentByOrderNumber(
  db: Database,
  orderNumber: string,
): Promise<GatewayPayment | null> {
  const [row] = await db
    .select(GATEWAY_PAYMENT_COLUMNS)
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(eq(orders.orderNumber, orderNumber))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  if (!row) return null;
  return toGatewayPayment(row);
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

export interface PendingGatewayPayment {
  paymentId: string;
  orderId: string;
  orderNumber: string;
  gatewayChargeId: string;
}

/**
 * Payments still sitting at `pending` on a given gateway, past a minimum age.
 *
 * Built 2026-11-26 for the worker's own reconcile sweep — confirmed in
 * production that Mercado Pago's Checkout Pro webhook was not reaching this
 * app at all (zero deliveries logged), so for that gateway this is not a
 * lagging-webhook safety net, it's the only path an order the customer never
 * reloads their own tracking page for will ever settle through. The minimum
 * age is there so a checkout still genuinely in progress a few seconds ago
 * isn't asked about before it's had a chance to finish on its own.
 */
export async function listPendingGatewayPayments(
  db: Database,
  input: { gateway: string; olderThanMs: number; limit: number },
): Promise<PendingGatewayPayment[]> {
  const cutoff = new Date(Date.now() - input.olderThanMs);
  const rows = await db
    .select({
      paymentId: payments.id,
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      gatewayChargeId: payments.gatewayChargeId,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(
      and(
        eq(payments.status, 'pending'),
        eq(payments.gateway, input.gateway),
        isNotNull(payments.gatewayChargeId),
        lt(payments.createdAt, cutoff),
      ),
    )
    .orderBy(asc(payments.createdAt))
    .limit(input.limit);

  return rows.map((r) => ({ ...r, gatewayChargeId: r.gatewayChargeId! }));
}
