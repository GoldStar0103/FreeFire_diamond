/**
 * Fulfilling a RocketPass vendor-item order (`orders.order_type = 'item'`).
 *
 * Structurally simpler than diamond fulfillment in `fulfillment.ts`: there is
 * exactly one item per order (no multi-call recipe to iterate), and
 * RocketPass's own response already says what happened —
 * `DELIVERED`/`PARTIAL`/`FAILED`/`PENDING`/`PROCESSING`/`CANCELLED` — so there
 * is no wallet-delta reconciliation to guess an ambiguous outcome from.
 *
 * What carries over unchanged is the durability discipline: `markSending`
 * commits BEFORE the HTTP call leaves the process, the same reason
 * `markItemSending` does for diamonds. Here that is also the entire
 * protection against double-charging on a crash — the `Idempotency-Key` sent
 * on every attempt is this order's own id, which never changes, so a retry
 * after a crash resends the identical key and RocketPass's own idempotency
 * cache returns the original result (`Idempotent-Replay`) instead of
 * charging twice. This is a vendor-documented guarantee, not something this
 * code re-derives — the one case it can't paper over is `DUPLICATE_ORDER`/
 * `IDEMPOTENCY_KEY_REUSED`/`IDEMPOTENCY_IN_PROGRESS` coming back with no
 * `rocketpass_order_id` on file locally (a crash between RocketPass
 * processing the call and this process recording the id) — that always
 * escalates to a human rather than guessing either way.
 */

import { RocketPassError, type CreateOrderInput, type RocketPassOrderStatus } from '@levelup/rocketpass';
import type { Alerter, AlertLevel } from './ports.js';

export type ItemFulfillmentStatus =
  | 'pending'
  | 'processing'
  | 'delivered'
  | 'partial'
  | 'failed'
  | 'awaiting_stock'
  | 'cancelled';

export interface ItemOrderRecord {
  id: string;
  orderNumber: string;
  /** Free Fire ID — RocketPass's `target_uid`. */
  playerId: string;
  sku: CreateOrderInput['item'];
  itemName: string;
  quantity: number;
  /** Null for memberships. */
  region: CreateOrderInput['region'] | null;
  fulfillmentStatus: ItemFulfillmentStatus;
  rocketpassOrderId: string | null;
  attemptCount: number;
}

/** What `RocketPassClient.createOrder` reported, reduced to what a decision needs. */
export type RocketPassCallResult =
  | { ok: true; rocketpassOrderId: string; status: RocketPassOrderStatus }
  | { ok: false; code: string; retryable: boolean };

export interface ItemFulfillmentDecision {
  itemStatus: ItemFulfillmentStatus;
  /** Null means "leave `orders.status` exactly as it is." */
  orderStatus: 'completed' | 'needs_review' | null;
  /** Set only when `rocketpassOrderId` should be (re)written. */
  rocketpassOrderId: string | null;
  alert: { level: AlertLevel; title: string; detail: Record<string, unknown> } | null;
}

/** Account/license-level problems — nothing to do with this specific item. */
const OPERATIONAL_CODES: ReadonlySet<string> = new Set([
  'INSUFFICIENT_BALANCE',
  'CONTRACT_EXPIRED',
  'DAILY_LIMIT_REACHED',
  'LICENSE_DISABLED',
  'IP_NOT_ALLOWED',
  'PERMISSION_DENIED',
  'MISSING_API_KEY',
  'INVALID_API_KEY',
  'MAINTENANCE',
]);

/** The one case where a failure must never be trusted either way — see the module doc comment. */
const AMBIGUOUS_IDEMPOTENCY_CODES: ReadonlySet<string> = new Set([
  'DUPLICATE_ORDER',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_IN_PROGRESS',
]);

/**
 * Decide what a RocketPass response/error means for this item order. Pure —
 * every branch is a fact about what RocketPass said plus how many times this
 * has already been tried, nothing more.
 */
export function decideItemFulfillment(
  result: RocketPassCallResult,
  attemptCount: number,
  maxAttempts: number,
): ItemFulfillmentDecision {
  if (result.ok) {
    switch (result.status) {
      case 'DELIVERED':
        return {
          itemStatus: 'delivered',
          orderStatus: 'completed',
          rocketpassOrderId: result.rocketpassOrderId,
          alert: null,
        };
      case 'PARTIAL':
        return {
          itemStatus: 'partial',
          orderStatus: 'needs_review',
          rocketpassOrderId: result.rocketpassOrderId,
          alert: {
            level: 'warn',
            title: 'RocketPass order partially delivered',
            detail: { rocketpassOrderId: result.rocketpassOrderId },
          },
        };
      case 'FAILED':
        return {
          itemStatus: 'failed',
          orderStatus: 'needs_review',
          rocketpassOrderId: result.rocketpassOrderId,
          alert: {
            level: 'critical',
            title: 'RocketPass order failed',
            detail: { rocketpassOrderId: result.rocketpassOrderId },
          },
        };
      case 'CANCELLED':
        return {
          itemStatus: 'cancelled',
          orderStatus: 'needs_review',
          rocketpassOrderId: result.rocketpassOrderId,
          alert: {
            level: 'warn',
            title: 'RocketPass cancelled an order',
            detail: { rocketpassOrderId: result.rocketpassOrderId },
          },
        };
      case 'PENDING':
      case 'PROCESSING':
        // Not final — the webhook (or a future poller) settles it from here.
        // `rocketpassOrderId` is recorded now regardless, so a retry never
        // re-places this order: once it exists, only polling/webhooks follow up.
        return {
          itemStatus: 'processing',
          orderStatus: null,
          rocketpassOrderId: result.rocketpassOrderId,
          alert: null,
        };
    }
  }

  if (AMBIGUOUS_IDEMPOTENCY_CODES.has(result.code)) {
    return {
      itemStatus: 'processing',
      orderStatus: 'needs_review',
      rocketpassOrderId: null,
      alert: {
        level: 'critical',
        title: 'RocketPass order outcome unknown after a crash-retry',
        detail: {
          code: result.code,
          note:
            "This order's Idempotency-Key was already used, but no rocketpass_order_id is on file. " +
            'Check RocketPass\'s own order history by reference (the order number) before touching anything.',
        },
      },
    };
  }

  if (result.code === 'OUT_OF_STOCK') {
    return {
      itemStatus: 'awaiting_stock',
      orderStatus: null,
      rocketpassOrderId: null,
      alert: { level: 'warn', title: 'RocketPass item out of stock', detail: { code: result.code } },
    };
  }

  if (OPERATIONAL_CODES.has(result.code)) {
    return {
      itemStatus: 'failed',
      orderStatus: 'needs_review',
      rocketpassOrderId: null,
      alert: { level: 'critical', title: 'RocketPass account/license problem', detail: { code: result.code } },
    };
  }

  if (result.retryable && attemptCount < maxAttempts) {
    // Stays `processing` — silently retried next sweep, same as diamonds
    // don't alert on every transient provider hiccup.
    return { itemStatus: 'processing', orderStatus: null, rocketpassOrderId: null, alert: null };
  }

  return {
    itemStatus: 'failed',
    orderStatus: 'needs_review',
    rocketpassOrderId: null,
    alert: {
      level: 'critical',
      title: result.retryable ? 'RocketPass order failed after exhausting retries' : 'RocketPass refused this order',
      detail: { code: result.code, attemptCount },
    },
  };
}

export interface ItemFulfillmentStore {
  loadItemOrder(orderId: string): Promise<ItemOrderRecord | null>;
  /** CAS to `processing` + `attempt_count + 1`, committed before the HTTP call goes out. */
  markSending(orderId: string): Promise<void>;
  applyDecision(orderId: string, decision: ItemFulfillmentDecision): Promise<void>;
}

/** Just the one method this needs — satisfied by the real `RocketPassClient` as-is. */
export interface RocketPassOrderClient {
  createOrder(input: CreateOrderInput): Promise<{ order: { orderId: string; status: RocketPassOrderStatus } }>;
}

export interface ItemFulfillmentDeps {
  store: ItemFulfillmentStore;
  client: RocketPassOrderClient;
  alerter: Alerter;
  config: { maxAttempts: number };
}

export type ItemFulfillmentOutcome =
  | { kind: 'already_placed' }
  | { kind: 'applied'; decision: ItemFulfillmentDecision };

/**
 * Place (or, if already placed, leave alone for the poller/webhook) one item
 * order with RocketPass.
 */
export async function fulfillItemOrder(deps: ItemFulfillmentDeps, orderId: string): Promise<ItemFulfillmentOutcome> {
  const order = await deps.store.loadItemOrder(orderId);
  if (!order) throw new Error(`Item order ${orderId} not found`);

  // Already placed by an earlier attempt — never call `createOrder` a second
  // time for the same item order once RocketPass has confirmed an id for it.
  // What happens to it from here is the poller/webhook's job, not this one's.
  if (order.rocketpassOrderId) return { kind: 'already_placed' };

  await deps.store.markSending(orderId);

  let callResult: RocketPassCallResult;
  try {
    const created = await deps.client.createOrder({
      item: order.sku,
      targetUid: order.playerId,
      quantity: order.quantity,
      ...(order.region ? { region: order.region } : {}),
      reference: order.orderNumber,
      idempotencyKey: order.id,
    });
    callResult = { ok: true, rocketpassOrderId: created.order.orderId, status: created.order.status };
  } catch (err) {
    callResult =
      err instanceof RocketPassError
        ? { ok: false, code: err.code, retryable: err.retryable }
        : { ok: false, code: 'UNREACHABLE', retryable: true };
  }

  const decision = decideItemFulfillment(callResult, order.attemptCount + 1, deps.config.maxAttempts);
  await deps.store.applyDecision(orderId, decision);

  if (decision.alert) {
    await deps.alerter.send(decision.alert.level, decision.alert.title, {
      orderNumber: order.orderNumber,
      sku: order.sku,
      ...decision.alert.detail,
    });
  }

  return { kind: 'applied', decision };
}

// ── settling from a webhook ──────────────────────────────────────────────────

export interface ItemWebhookOrderLookup {
  orderId: string;
  attemptCount: number;
}

export interface ItemWebhookStore {
  /** Null when the id is unrecognised — a webhook for an order this store never placed, or a race ahead of our own write. */
  findItemOrderByRocketpassId(rocketpassOrderId: string): Promise<ItemWebhookOrderLookup | null>;
  applyDecision(orderId: string, decision: ItemFulfillmentDecision): Promise<void>;
}

export interface ItemWebhookDeps {
  store: ItemWebhookStore;
  alerter: Alerter;
  config: { maxAttempts: number };
}

export type ItemWebhookOutcome =
  | { kind: 'applied'; orderId: string; decision: ItemFulfillmentDecision }
  | { kind: 'unrecognised' };

/**
 * Apply `order.delivered`/`order.partial`/`order.failed`'s settlement to the
 * item order it belongs to. Reuses `decideItemFulfillment` exactly as the
 * initial placement call does — a webhook reporting `DELIVERED` and a
 * synchronous response reporting `DELIVERED` mean the same thing and must be
 * handled identically, not by a second, separately-maintained mapping.
 *
 * Idempotent by the caller's own doing, not this function's: the webhook
 * route records the event id in `payment_events` before calling this, so a
 * redelivered event never reaches here twice. This function itself is also
 * safe to call twice regardless — `applyDecision`'s own notification insert
 * is guarded by the `(order_id, type)` unique index.
 */
export async function applyRocketPassWebhookOrder(
  deps: ItemWebhookDeps,
  order: { rocketpassOrderId: string; status: RocketPassOrderStatus },
): Promise<ItemWebhookOutcome> {
  const found = await deps.store.findItemOrderByRocketpassId(order.rocketpassOrderId);
  if (!found) return { kind: 'unrecognised' };

  const decision = decideItemFulfillment(
    { ok: true, rocketpassOrderId: order.rocketpassOrderId, status: order.status },
    found.attemptCount,
    deps.config.maxAttempts,
  );
  await deps.store.applyDecision(found.orderId, decision);

  if (decision.alert) {
    await deps.alerter.send(decision.alert.level, decision.alert.title, {
      orderId: found.orderId,
      ...decision.alert.detail,
    });
  }

  return { kind: 'applied', orderId: found.orderId, decision };
}
