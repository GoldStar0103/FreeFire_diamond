/**
 * Public read models for the storefront.
 *
 * Two boundaries are deliberate and load-bearing:
 *
 *   1. The recipe never crosses this line. LevelUp's whole differentiator is
 *      that customers see combos while competitors sell the six commodity
 *      denominations. Leaking that "Pack Insano" is 5,600 + 1,060 would hand a
 *      competitor the pricing model and let a customer price the parts.
 *      Provider costs obviously never leave either.
 *
 *   2. Order lookup requires the order number AND the player ID together.
 *      Order numbers are short enough to guess at; pairing them with the Free
 *      Fire ID means knowing one is not enough to read someone else's order.
 *
 * Everything here returns a shape a page renders directly.
 */

import { and, asc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../index.js';
import { campaigns, combos, orderItems, orders } from '../schema.js';

// ── catalog ───────────────────────────────────────────────────────────────────

export interface StorefrontCombo {
  key: string;
  name: string;
  priceMxnCents: number;
  /** What the flyer promises. The recipe behind it is not exposed. */
  advertisedDiamonds: number;
  maxPerPlayer: number | null;
}

export interface StorefrontCampaign {
  key: string;
  name: string;
  flyerAssetUrl: string | null;
  badge: string | null;
  permanent: boolean;
  combos: StorefrontCombo[];
}

/** Active now: the combo and its campaign both on, and both inside their window. */
function liveConditions(now: Date) {
  return [
    eq(combos.active, true),
    eq(campaigns.active, true),
    or(isNull(combos.startsAt), lte(combos.startsAt, now)),
    or(isNull(combos.endsAt), gte(combos.endsAt, now)),
    or(isNull(campaigns.startsAt), lte(campaigns.startsAt, now)),
    or(isNull(campaigns.endsAt), gte(campaigns.endsAt, now)),
  ];
}

/**
 * Everything on sale right now, grouped by campaign.
 *
 * Permanent campaigns first — the $10 Mega Oferta is the entry offer for
 * distrustful first-time buyers and has to lead.
 */
export async function listStorefront(
  db: Database,
  now = new Date(),
): Promise<StorefrontCampaign[]> {
  const rows = await db
    .select({
      campaignKey: campaigns.key,
      campaignName: campaigns.name,
      flyerAssetUrl: campaigns.flyerAssetUrl,
      badge: campaigns.badge,
      permanent: campaigns.permanent,
      campaignSort: campaigns.sortOrder,
      comboKey: combos.key,
      comboName: combos.name,
      priceMxnCents: combos.priceMxnCents,
      advertisedDiamonds: combos.advertisedDiamonds,
      maxPerPlayer: combos.maxPerPlayer,
      comboSort: combos.sortOrder,
    })
    .from(combos)
    .innerJoin(campaigns, eq(campaigns.id, combos.campaignId))
    .where(and(...liveConditions(now)))
    .orderBy(
      // Permanent (the $10 hook) leads, then the client's own ordering.
      sql`${campaigns.permanent} DESC`,
      asc(campaigns.sortOrder),
      asc(combos.sortOrder),
    );

  const byCampaign = new Map<string, StorefrontCampaign>();
  for (const r of rows) {
    let campaign = byCampaign.get(r.campaignKey);
    if (!campaign) {
      campaign = {
        key: r.campaignKey,
        name: r.campaignName,
        flyerAssetUrl: r.flyerAssetUrl,
        badge: r.badge,
        permanent: r.permanent,
        combos: [],
      };
      byCampaign.set(r.campaignKey, campaign);
    }
    campaign.combos.push({
      key: r.comboKey,
      name: r.comboName,
      priceMxnCents: r.priceMxnCents,
      advertisedDiamonds: r.advertisedDiamonds,
      maxPerPlayer: r.maxPerPlayer,
    });
  }

  return [...byCampaign.values()];
}

/** One combo, for the checkout page. Null when it is not currently on sale. */
export async function getStorefrontCombo(
  db: Database,
  comboKey: string,
  now = new Date(),
): Promise<(StorefrontCombo & { campaignName: string; flyerAssetUrl: string | null }) | null> {
  const [row] = await db
    .select({
      key: combos.key,
      name: combos.name,
      priceMxnCents: combos.priceMxnCents,
      advertisedDiamonds: combos.advertisedDiamonds,
      maxPerPlayer: combos.maxPerPlayer,
      campaignName: campaigns.name,
      flyerAssetUrl: campaigns.flyerAssetUrl,
    })
    .from(combos)
    .innerJoin(campaigns, eq(campaigns.id, combos.campaignId))
    .where(and(eq(combos.key, comboKey), ...liveConditions(now)))
    .limit(1);

  return row ?? null;
}

// ── order tracking ────────────────────────────────────────────────────────────

/** What the customer is shown. Deliberately coarse — see below. */
export type CustomerOrderStatus =
  | 'esperando_pago'
  | 'pago_en_revision'
  | 'procesando'
  | 'completado'
  | 'con_problema'
  | 'cancelado';

export interface CustomerOrder {
  orderNumber: string;
  comboName: string;
  playerId: string;
  playerNickname: string | null;
  priceMxnCents: number;
  advertisedDiamonds: number;
  status: CustomerOrderStatus;
  /** Diamonds in the player's account so far. */
  deliveredDiamonds: number;
  createdAt: Date;
  completedAt: Date | null;
  /** True once an admin needs to intervene — the only time support is offered. */
  needsSupport: boolean;
}

/**
 * Collapse internal state into what the customer should see.
 *
 * The customer bought one thing, so they see one thing. Exposing that their
 * order is eight provider calls, three of which succeeded, would undo the
 * single-purchase experience the whole product is built around — and invite
 * questions about mechanics they have no way to act on.
 *
 * `needs_review` becomes "con problema" rather than anything alarming: an admin
 * is already on it, and the alert fired before the customer ever refreshed.
 */
function toCustomerStatus(orderStatus: string, paymentUnderReview: boolean): CustomerOrderStatus {
  switch (orderStatus) {
    case 'pending_payment':
      return paymentUnderReview ? 'pago_en_revision' : 'esperando_pago';
    case 'payment_confirmed':
    case 'processing':
    case 'partially_delivered':
      return 'procesando';
    case 'completed':
      return 'completado';
    case 'needs_review':
    case 'refund_required':
      return 'con_problema';
    default:
      return 'cancelado';
  }
}

/**
 * Look up one order for its owner.
 *
 * Requires both the order number and the player ID. There are no accounts —
 * this pairing is the whole authorisation model, so it must never be relaxed
 * to just the order number.
 */
export async function findCustomerOrder(
  db: Database,
  orderNumber: string,
  playerId: string,
): Promise<CustomerOrder | null> {
  const [row] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      playerId: orders.playerId,
      playerNickname: orders.playerNickname,
      priceMxnCents: orders.priceMxnCents,
      comboSnapshot: orders.comboSnapshot,
      status: orders.status,
      createdAt: orders.createdAt,
      completedAt: orders.completedAt,
    })
    .from(orders)
    .where(
      and(
        eq(orders.orderNumber, orderNumber.trim().toUpperCase()),
        eq(orders.playerId, playerId.trim()),
      ),
    )
    .limit(1);

  if (!row) return null;

  const items = await db
    .select({ status: orderItems.status, diamondsBase: orderItems.diamondsBase })
    .from(orderItems)
    .where(eq(orderItems.orderId, row.id));

  const deliveredDiamonds = items
    .filter((i) => i.status === 'succeeded')
    .reduce((sum, i) => sum + (i.diamondsBase * 110) / 100, 0);

  const snapshot = row.comboSnapshot as { name?: string; advertisedDiamonds?: number };
  const status = toCustomerStatus(row.status, false);

  return {
    orderNumber: row.orderNumber,
    comboName: snapshot.name ?? 'Recarga',
    playerId: row.playerId,
    playerNickname: row.playerNickname,
    priceMxnCents: row.priceMxnCents,
    advertisedDiamonds: snapshot.advertisedDiamonds ?? 0,
    status,
    deliveredDiamonds,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    // Support is surfaced only here — the client does not want a floating
    // WhatsApp button for a market full of curious children.
    needsSupport: status === 'con_problema',
  };
}

/** Delivered-orders counter for the trust page. */
export async function countCompletedOrders(db: Database): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`COUNT(*)::text` })
    .from(orders)
    .where(eq(orders.status, 'completed'));
  return Number(row?.n ?? 0);
}
