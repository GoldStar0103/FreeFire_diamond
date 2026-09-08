/**
 * Read models for the admin panel.
 *
 * Kept out of the Next.js app so they can be tested against a real database
 * rather than only exercised by clicking. Each function returns a shape a
 * screen renders directly — no joining or formatting left for the component.
 *
 * Money crosses this boundary as integer centavos and provider cost as a
 * decimal string; formatting is the UI's job, never arithmetic.
 */

import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '../index.js';
import { baseProducts, campaigns, combos, orderItems, orders, payments } from '../schema.js';

// ── the approval queue ────────────────────────────────────────────────────────

export interface PendingApproval {
  orderId: string;
  orderNumber: string;
  playerId: string;
  playerNickname: string | null;
  comboName: string;
  advertisedDiamonds: number;
  priceMxnCents: number;
  method: string;
  paymentStatus: string;
  comprobanteUrl: string | null;
  amountReceivedCents: number | null;
  /** Set when the customer paid a different amount — needs a human decision. */
  mismatch: boolean;
  createdAt: Date;
  expiresAt: Date | null;
}

/**
 * Orders waiting on someone to confirm the money arrived.
 *
 * This is the screen that replaces the manual WhatsApp back-and-forth: the
 * customer sends a comprobante, an admin taps approve, fulfilment runs itself.
 * Oldest first — a customer who has been waiting longest is the most annoyed.
 */
export async function listPendingApprovals(
  db: Database,
  limit = 50,
): Promise<PendingApproval[]> {
  const rows = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      playerId: orders.playerId,
      playerNickname: orders.playerNickname,
      comboSnapshot: orders.comboSnapshot,
      priceMxnCents: orders.priceMxnCents,
      createdAt: orders.createdAt,
      method: payments.method,
      paymentStatus: payments.status,
      comprobanteUrl: payments.comprobanteAssetUrl,
      amountReceivedCents: payments.amountReceivedCents,
      amountExpectedCents: payments.amountExpectedCents,
      expiresAt: payments.expiresAt,
    })
    .from(orders)
    .innerJoin(payments, eq(payments.orderId, orders.id))
    .where(
      and(
        eq(orders.status, 'pending_payment'),
        inArray(payments.status, ['pending', 'under_review', 'amount_mismatch']),
      ),
    )
    .orderBy(orders.createdAt)
    .limit(limit);

  return rows.map((r) => {
    const snapshot = r.comboSnapshot as { name?: string; advertisedDiamonds?: number };
    return {
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      playerId: r.playerId,
      playerNickname: r.playerNickname,
      comboName: snapshot.name ?? '(combo desconocido)',
      advertisedDiamonds: snapshot.advertisedDiamonds ?? 0,
      priceMxnCents: r.priceMxnCents,
      method: r.method,
      paymentStatus: r.paymentStatus,
      comprobanteUrl: r.comprobanteUrl,
      amountReceivedCents: r.amountReceivedCents,
      mismatch:
        r.amountReceivedCents !== null && r.amountReceivedCents !== r.amountExpectedCents,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    };
  });
}

// ── the orders list ───────────────────────────────────────────────────────────

export type OrderFilter =
  | 'all'
  | 'needs_attention'
  | 'pending_payment'
  | 'processing'
  | 'completed';

export interface OrderListRow {
  orderId: string;
  orderNumber: string;
  playerId: string;
  playerNickname: string | null;
  comboName: string;
  priceMxnCents: number;
  status: string;
  itemsTotal: number;
  itemsDelivered: number;
  createdAt: Date;
  completedAt: Date | null;
}

/** Statuses a human has to look at. The default view of the orders screen. */
const NEEDS_ATTENTION = ['needs_review', 'refund_required', 'partially_delivered'] as const;

export async function listOrders(
  db: Database,
  options: { filter?: OrderFilter; search?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: OrderListRow[]; total: number }> {
  const { filter = 'all', search, limit = 50, offset = 0 } = options;

  const conditions = [];
  if (filter === 'needs_attention') conditions.push(inArray(orders.status, [...NEEDS_ATTENTION]));
  else if (filter !== 'all') conditions.push(eq(orders.status, filter));

  // Match either the order number or the Free Fire ID — the two things a
  // customer actually quotes over WhatsApp.
  if (search) {
    conditions.push(
      sql`(${orders.orderNumber} ILIKE ${'%' + search + '%'} OR ${orders.playerId} LIKE ${'%' + search + '%'})`,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      playerId: orders.playerId,
      playerNickname: orders.playerNickname,
      comboSnapshot: orders.comboSnapshot,
      priceMxnCents: orders.priceMxnCents,
      status: orders.status,
      createdAt: orders.createdAt,
      completedAt: orders.completedAt,
    })
    .from(orders)
    .where(where)
    .orderBy(desc(orders.createdAt))
    .limit(limit)
    .offset(offset);

  const [totalRow] = await db.select({ value: count() }).from(orders).where(where);

  // Counted in a second grouped query rather than a correlated subquery —
  // one extra round trip, and the SQL is obvious at a glance.
  const counts = new Map<string, { total: number; delivered: number }>();
  if (rows.length > 0) {
    const countRows = await db
      .select({
        orderId: orderItems.orderId,
        total: count(),
        delivered: sql<string>`COUNT(*) FILTER (WHERE ${orderItems.status} = 'succeeded')::text`,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, rows.map((r) => r.orderId)))
      .groupBy(orderItems.orderId);

    for (const c of countRows) {
      counts.set(c.orderId, { total: c.total, delivered: Number(c.delivered) });
    }
  }

  return {
    rows: rows.map((r) => {
      const c = counts.get(r.orderId);
      return {
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        playerId: r.playerId,
        playerNickname: r.playerNickname,
        comboName: (r.comboSnapshot as { name?: string }).name ?? '(combo desconocido)',
        priceMxnCents: r.priceMxnCents,
        status: r.status,
        itemsTotal: c?.total ?? 0,
        itemsDelivered: c?.delivered ?? 0,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      };
    }),
    total: totalRow?.value ?? 0,
  };
}

// ── order detail ──────────────────────────────────────────────────────────────

export interface OrderItemDetail {
  itemId: string;
  sequence: number;
  providerProductId: string;
  diamondsBase: number;
  status: string;
  attemptCount: number;
  errorCode: string | null;
  /** How the outcome was established — 'wallet_delta' is the interesting one. */
  resolvedBy: string | null;
  providerTransactionId: string | null;
  providerReference: string | null;
  costUsd: string | null;
  walletBeforeUsd: string | null;
  walletAfterUsd: string | null;
  requestPayload: unknown;
  responsePayload: unknown;
  sentAt: Date | null;
  settledAt: Date | null;
}

export interface OrderDetail {
  orderId: string;
  orderNumber: string;
  playerId: string;
  playerNickname: string | null;
  serverId: string | null;
  contactWhatsapp: string | null;
  status: string;
  priceMxnCents: number;
  comboSnapshot: unknown;
  createdAt: Date;
  paidAt: Date | null;
  completedAt: Date | null;
  payment: {
    paymentId: string;
    method: string;
    status: string;
    amountExpectedCents: number;
    amountReceivedCents: number | null;
    comprobanteUrl: string | null;
    reference: string | null;
    expiresAt: Date | null;
    paidAt: Date | null;
  } | null;
  items: OrderItemDetail[];
  /** Diamonds actually delivered so far, against what was promised. */
  progress: { delivered: number; total: number; pct: number };
}

/**
 * Everything about one order, including the raw provider request and response
 * for each call.
 *
 * The raw payloads matter: when a customer disputes a recharge, this screen is
 * the evidence. It is also what shows a sceptical reader that an ambiguous call
 * was resolved by wallet comparison rather than by guessing.
 */
export async function getOrderDetail(db: Database, orderId: string): Promise<OrderDetail | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return null;

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.sequence);

  const bonusPct = 10;
  const delivered = items
    .filter((i) => i.status === 'succeeded')
    .reduce((sum, i) => sum + (i.diamondsBase * (100 + bonusPct)) / 100, 0);
  const total = items.reduce((sum, i) => sum + (i.diamondsBase * (100 + bonusPct)) / 100, 0);

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    playerId: order.playerId,
    playerNickname: order.playerNickname,
    serverId: order.serverId,
    contactWhatsapp: order.contactWhatsapp,
    status: order.status,
    priceMxnCents: order.priceMxnCents,
    comboSnapshot: order.comboSnapshot,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    completedAt: order.completedAt,
    payment: payment
      ? {
          paymentId: payment.id,
          method: payment.method,
          status: payment.status,
          amountExpectedCents: payment.amountExpectedCents,
          amountReceivedCents: payment.amountReceivedCents,
          comprobanteUrl: payment.comprobanteAssetUrl,
          reference: payment.reference,
          expiresAt: payment.expiresAt,
          paidAt: payment.paidAt,
        }
      : null,
    items: items.map((i) => ({
      itemId: i.id,
      sequence: i.sequence,
      providerProductId: i.providerProductId,
      diamondsBase: i.diamondsBase,
      status: i.status,
      attemptCount: i.attemptCount,
      errorCode: i.errorCode,
      resolvedBy: i.resolvedBy,
      providerTransactionId: i.providerTransactionId,
      providerReference: i.providerReference,
      costUsd: i.costUsd,
      walletBeforeUsd: i.walletBeforeUsd,
      walletAfterUsd: i.walletAfterUsd,
      requestPayload: i.requestPayload,
      responsePayload: i.responsePayload,
      sentAt: i.sentAt,
      settledAt: i.settledAt,
    })),
    progress: { delivered, total, pct: total === 0 ? 0 : (delivered / total) * 100 },
  };
}

// ── dashboard ─────────────────────────────────────────────────────────────────

export interface DashboardStats {
  awaitingApproval: number;
  processing: number;
  needsReview: number;
  completedToday: number;
  revenueTodayCents: number;
  /** Combos blocked from sale because their recipe under-delivers. */
  inactiveCombos: Array<{ key: string; name: string }>;
  /** Denominations with no active provider product — combos using them will fail. */
  missingProducts: number[];
}

export async function getDashboardStats(db: Database): Promise<DashboardStats> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const statusRows = await db
    .select({ status: orders.status, n: count() })
    .from(orders)
    .groupBy(orders.status);

  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, r.n]));

  const [today] = await db
    .select({
      n: count(),
      revenue: sql<string>`COALESCE(SUM(${orders.priceMxnCents}), 0)::text`,
    })
    .from(orders)
    .where(and(eq(orders.status, 'completed'), gte(orders.completedAt, startOfDay)));

  const inactive = await db
    .select({ key: combos.key, name: combos.name })
    .from(combos)
    .where(eq(combos.active, false));

  // Which of the six base denominations currently have no sellable product.
  const active = await db
    .select({ diamondsBase: baseProducts.diamondsBase })
    .from(baseProducts)
    .where(eq(baseProducts.active, true));
  const have = new Set(active.map((p) => p.diamondsBase));
  const missingProducts = [100, 310, 520, 1060, 2180, 5600].filter((d) => !have.has(d));

  return {
    awaitingApproval: byStatus['pending_payment'] ?? 0,
    processing: (byStatus['processing'] ?? 0) + (byStatus['partially_delivered'] ?? 0),
    needsReview: byStatus['needs_review'] ?? 0,
    completedToday: today?.n ?? 0,
    revenueTodayCents: Number(today?.revenue ?? 0),
    inactiveCombos: inactive,
    missingProducts,
  };
}

// ── combo catalog ─────────────────────────────────────────────────────────────

export interface ComboAdminRow {
  comboId: string;
  key: string;
  name: string;
  campaignName: string;
  campaignActive: boolean;
  priceMxnCents: number;
  advertisedDiamonds: number;
  deliveredDiamonds: number;
  /** Negative means the flyer promises more than the recipe delivers. */
  gap: number;
  callCount: number;
  costUsd: string | null;
  active: boolean;
  maxPerPlayer: number | null;
}

/**
 * The combo catalog with its recipe maths already done.
 *
 * `gap` is the number the client needs to see every month when they rotate
 * flyers — three of the nineteen September combos were negative.
 */
export async function listCombosForAdmin(db: Database): Promise<ComboAdminRow[]> {
  const rows = await db.execute<{
    combo_id: string;
    key: string;
    name: string;
    campaign_name: string;
    campaign_active: boolean;
    price_mxn_cents: number;
    advertised_diamonds: number;
    delivered_diamonds: string;
    call_count: string;
    cost_usd: string | null;
    active: boolean;
    max_per_player: number | null;
  }>(sql`
    SELECT c.id AS combo_id,
           c.key,
           c.name,
           ca.name       AS campaign_name,
           ca.active     AS campaign_active,
           c.price_mxn_cents,
           c.advertised_diamonds,
           c.active,
           c.max_per_player,
           COALESCE(SUM(bp.diamonds_base * (100 + bp.bonus_pct) / 100), 0)::text AS delivered_diamonds,
           COUNT(ci.id)::text                                                    AS call_count,
           CASE WHEN COUNT(ci.id) = 0 OR BOOL_OR(bp.cost_usd IS NULL) THEN NULL
                ELSE SUM(bp.cost_usd)::text END                                  AS cost_usd
      FROM combos c
      JOIN campaigns ca   ON ca.id = c.campaign_id
 LEFT JOIN combo_items ci ON ci.combo_id = c.id
 LEFT JOIN base_products bp ON bp.id = ci.base_product_id
  GROUP BY c.id, c.key, c.name, ca.name, ca.active, c.price_mxn_cents,
           c.advertised_diamonds, c.active, c.max_per_player, c.sort_order
  ORDER BY ca.name, c.sort_order
  `);

  return rows.map((r) => {
    const deliveredDiamonds = Number(r.delivered_diamonds);
    return {
      comboId: r.combo_id,
      key: r.key,
      name: r.name,
      campaignName: r.campaign_name,
      campaignActive: r.campaign_active,
      priceMxnCents: r.price_mxn_cents,
      advertisedDiamonds: r.advertised_diamonds,
      deliveredDiamonds,
      gap: deliveredDiamonds - r.advertised_diamonds,
      callCount: Number(r.call_count),
      costUsd: r.cost_usd,
      active: r.active,
      maxPerPlayer: r.max_per_player,
    };
  });
}
