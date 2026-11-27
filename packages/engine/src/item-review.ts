/**
 * Manually releasing a RocketPass item order — the item-order equivalent of
 * `review.ts`'s diamond actions. Added 2026-11-27 per Jose's report: item
 * orders can sit stuck (`processing`/`needs_review`) in this dashboard while
 * he's already confirmed directly in RocketPass's own portal that the order
 * went through — the admin needs a way to say "I checked, it's fine" and
 * close the order out, the same way `mark_item_delivered`/
 * `mark_item_delivered_manually` already let an admin do for a diamond
 * order.
 *
 * Deliberately narrower than `review.ts`: an item order has exactly one line
 * item, so there is nothing to pick between — just "release this order" or
 * leave it alone. Not a replacement for the automatic reconcile sweep
 * (`item-reconcile.ts`), which asks RocketPass's API directly; this is the
 * manual fallback for whenever that still isn't enough — e.g. the admin saw
 * it confirmed in RocketPass's own web portal, which this API can't see.
 */

import { assertTransition, type OrderStatus } from './states.js';

export interface ItemReviewOrder {
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  /**
   * Null means RocketPass never actually created an order for this attempt —
   * e.g. it was refused outright (`INSUFFICIENT_BALANCE` and the like) before
   * ever reaching their system. That is exactly the condition that makes a
   * retry safe: nothing to double-send. A non-null id means RocketPass does
   * have something on file, which `retryItemOrderManually` below refuses —
   * that case belongs to `releaseItemOrderManually` instead, after checking
   * RocketPass's own portal for what it actually did with it.
   */
  rocketpassOrderId: string | null;
}

export type ItemReviewFailureCode =
  | 'ORDER_NOT_FOUND'
  | 'ALREADY_RESOLVED'
  | 'ILLEGAL_TRANSITION'
  | 'NOT_RETRYABLE'
  | 'NOTE_REQUIRED'
  | 'CONFLICT';

export interface ItemReviewFailure {
  code: ItemReviewFailureCode;
  message: string;
}

/** Thrown by the store's compare-and-set when the order moved since it was loaded. */
export class ItemReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemReviewConflictError';
  }
}

export interface ItemReviewStore {
  loadItemOrderForReview(orderId: string): Promise<ItemReviewOrder | null>;
  /** Compare-and-set on `expectedOrderStatus`; throws `ItemReviewConflictError` if it moved. */
  releaseItemOrderManually(input: {
    orderId: string;
    expectedOrderStatus: OrderStatus;
    adminUserId: string;
    note: string;
  }): Promise<void>;
  /**
   * Compare-and-set on `expectedOrderStatus`; throws `ItemReviewConflictError`
   * if it moved. Puts the item back to `pending` with a fresh retry budget —
   * the same state `claimNext` already picks up from, so the very next sweep
   * tick places it with RocketPass again, no separate "resume" step needed.
   */
  retryItemOrderManually(input: {
    orderId: string;
    expectedOrderStatus: OrderStatus;
    adminUserId: string;
    note: string;
  }): Promise<void>;
}

/** Nothing left to release — a terminal status, or a refund already in motion. */
const NOT_RELEASABLE: ReadonlySet<OrderStatus> = new Set([
  'completed',
  'cancelled',
  'payment_expired',
  'refunded',
  'refund_required',
]);

export interface ItemReviewDeps {
  store: ItemReviewStore;
}

export type ItemReviewResult = { ok: true; orderNumber: string } | { ok: false; failure: ItemReviewFailure };

/**
 * Manually mark a stuck item order as delivered and close it out. Only valid
 * while the order hasn't already reached a terminal state (or a refund
 * flagged) — a completed order has its own, separate reversal path.
 */
export async function releaseItemOrderManually(
  deps: ItemReviewDeps,
  input: { orderId: string; adminUserId: string; note: string },
): Promise<ItemReviewResult> {
  const order = await deps.store.loadItemOrderForReview(input.orderId);
  if (!order) {
    return { ok: false, failure: { code: 'ORDER_NOT_FOUND', message: `No order ${input.orderId}.` } };
  }

  if (NOT_RELEASABLE.has(order.orderStatus)) {
    return {
      ok: false,
      failure: { code: 'ALREADY_RESOLVED', message: `${order.orderNumber} is already ${order.orderStatus}.` },
    };
  }

  try {
    assertTransition(order.orderStatus, 'completed');
  } catch {
    return {
      ok: false,
      failure: {
        code: 'ILLEGAL_TRANSITION',
        message: `${order.orderNumber} can't go straight from ${order.orderStatus} to completed. Reload and check its status.`,
      },
    };
  }

  const note = input.note.trim();
  if (note.length < 3) {
    return {
      ok: false,
      failure: { code: 'NOTE_REQUIRED', message: 'Say how delivery was confirmed (RocketPass order id, screenshot, etc).' },
    };
  }

  try {
    await deps.store.releaseItemOrderManually({
      orderId: order.orderId,
      expectedOrderStatus: order.orderStatus,
      adminUserId: input.adminUserId,
      note,
    });
  } catch (err) {
    if (err instanceof ItemReviewConflictError) {
      return { ok: false, failure: { code: 'CONFLICT', message: err.message } };
    }
    throw err;
  }

  return { ok: true, orderNumber: order.orderNumber };
}

/**
 * Manually retry a `needs_review` item order RocketPass never actually
 * placed — e.g. one refused with `INSUFFICIENT_BALANCE` before the account
 * was topped back up. Only safe when `rocketpassOrderId` is null: nothing
 * was ever created there, so resending is never a double-send. An order
 * RocketPass *did* create (a non-null id) must go through
 * `releaseItemOrderManually` instead, after checking RocketPass's own portal
 * for what actually happened to it — retrying that one would reuse the same
 * `Idempotency-Key` (this order's own id, see `item-fulfillment.ts`'s doc
 * comment) against an attempt RocketPass may already have a cached outcome
 * for, which isn't what a human asking to "try again" wants.
 */
export async function retryItemOrderManually(
  deps: ItemReviewDeps,
  input: { orderId: string; adminUserId: string; note: string },
): Promise<ItemReviewResult> {
  const order = await deps.store.loadItemOrderForReview(input.orderId);
  if (!order) {
    return { ok: false, failure: { code: 'ORDER_NOT_FOUND', message: `No order ${input.orderId}.` } };
  }

  if (order.orderStatus !== 'needs_review') {
    return {
      ok: false,
      failure: {
        code: 'ILLEGAL_TRANSITION',
        message: `${order.orderNumber} is ${order.orderStatus}, not needs_review. Reload and check its status.`,
      },
    };
  }

  if (order.rocketpassOrderId !== null) {
    return {
      ok: false,
      failure: {
        code: 'NOT_RETRYABLE',
        message: `RocketPass already has an order on file for ${order.orderNumber} (${order.rocketpassOrderId}) — check its own portal and use the release action instead, not retry.`,
      },
    };
  }

  const note = input.note.trim();
  if (note.length < 3) {
    return {
      ok: false,
      failure: { code: 'NOTE_REQUIRED', message: 'Say why this is safe to retry now (e.g. the balance was topped up).' },
    };
  }

  try {
    await deps.store.retryItemOrderManually({
      orderId: order.orderId,
      expectedOrderStatus: order.orderStatus,
      adminUserId: input.adminUserId,
      note,
    });
  } catch (err) {
    if (err instanceof ItemReviewConflictError) {
      return { ok: false, failure: { code: 'CONFLICT', message: err.message } };
    }
    throw err;
  }

  return { ok: true, orderNumber: order.orderNumber };
}
