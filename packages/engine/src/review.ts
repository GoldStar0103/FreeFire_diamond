/**
 * Resolving an order a human has to look at.
 *
 * The fulfilment engine is built to stop rather than guess: an ambiguous
 * provider call it cannot settle from the wallet, retries that ran out, a
 * wallet too low to finish a combo — all of them park the order in
 * `needs_review` and alert. That is only half a design unless the person who
 * gets the alert can then *do* something from the panel. Before this, the
 * manual told the owner to "mark it delivered" or "retry it" and neither
 * button existed; a stuck paid order needed a developer with database access.
 *
 * The rules, in order of importance:
 *
 *   1. Never let a click cause a second delivery. Re-sending an item whose
 *      outcome is `unknown` is exactly how a customer ends up with double
 *      diamonds, so it demands an explicit "I checked the provider panel and
 *      it was NOT charged". Resuming the order is refused while any item is
 *      still unknown or in flight.
 *   2. Every action is compare-and-set. The plan records the statuses it was
 *      computed against; the store applies it only if nothing moved in the
 *      meantime — two admins, or a sweep that settled an item seconds ago,
 *      produce a conflict instead of a silent overwrite.
 *   3. Every action is attributable. The store writes the audit row in the
 *      same transaction as the change.
 *
 * Pure: `planReview` decides, `applyReviewAction` asks the store to commit.
 */

import type { OrderItemStatus, OrderStatus } from './states.js';
import { assertTransition } from './states.js';

export interface ReviewItem {
  id: string;
  sequence: number;
  status: OrderItemStatus;
  attemptCount: number;
  diamondsBase: number;
}

export interface ReviewOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  items: ReviewItem[];
}

export type ReviewAction =
  /** The admin found the transaction in the provider panel: it landed. */
  | { kind: 'mark_item_delivered'; itemId: string }
  /**
   * It did not land. Puts the item back in the queue with a fresh retry
   * budget; nothing is sent until the order is resumed.
   */
  | { kind: 'mark_item_not_delivered'; itemId: string; confirmedNotCharged: boolean }
  /** Send whatever is still missing — after a wallet top-up, or exhausted retries. */
  | { kind: 'resume' }
  /** Stop for good; the customer is owed money back. */
  | { kind: 'flag_refund'; note: string }
  /** The refund has been made. */
  | { kind: 'refund_done'; note: string };

export interface ItemUpdate {
  itemId: string;
  /** Compare-and-set: applied only if the item is still in this state. */
  expectedStatus: OrderItemStatus;
  status: 'succeeded' | 'queued';
  /** Give a re-queued item a fresh retry budget. */
  resetAttempts: boolean;
}

export interface ReviewPlan {
  orderId: string;
  orderNumber: string;
  /** Compare-and-set on the order, like the items. */
  expectedOrderStatus: OrderStatus;
  nextOrderStatus: OrderStatus;
  itemUpdates: ItemUpdate[];
  audit: { action: string; detail: Record<string, unknown> };
}

export type ReviewFailureCode =
  | 'ORDER_NOT_FOUND'
  | 'WRONG_ORDER_STATUS'
  | 'ITEM_NOT_FOUND'
  | 'ITEM_NOT_RESOLVABLE'
  | 'NEEDS_CONFIRMATION'
  | 'UNRESOLVED_ITEMS'
  | 'NOTHING_TO_RESUME'
  | 'NOTE_REQUIRED'
  | 'CONFLICT';

export interface ReviewFailure {
  code: ReviewFailureCode;
  message: string;
}

export type PlanResult = { ok: true; plan: ReviewPlan } | { ok: false; failure: ReviewFailure };

/** Thrown by a store whose compare-and-set found the order or an item had moved. */
export class ReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewConflictError';
  }
}

export interface ReviewStore {
  loadForReview(orderId: string): Promise<ReviewOrder | null>;
  /** Apply atomically, honouring every expected status; throw `ReviewConflictError` otherwise. */
  applyReview(plan: ReviewPlan, adminUserId: string): Promise<void>;
}

/** Items whose outcome a human may settle. */
const RESOLVABLE: ReadonlySet<OrderItemStatus> = new Set<OrderItemStatus>(['unknown', 'failed']);

const fail = (code: ReviewFailureCode, message: string): PlanResult => ({
  ok: false,
  failure: { code, message },
});

function requireStatus(order: ReviewOrder, status: OrderStatus): ReviewFailure | null {
  return order.status === status
    ? null
    : {
        code: 'WRONG_ORDER_STATUS',
        message: `${order.orderNumber} is ${order.status}, not ${status}.`,
      };
}

function plan(
  order: ReviewOrder,
  nextOrderStatus: OrderStatus,
  itemUpdates: ItemUpdate[],
  action: string,
  detail: Record<string, unknown>,
): PlanResult {
  // A plan that breaks the state machine is a bug here, not an admin error.
  assertTransition(order.status, nextOrderStatus);
  return {
    ok: true,
    plan: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      expectedOrderStatus: order.status,
      nextOrderStatus,
      itemUpdates,
      audit: { action, detail: { orderNumber: order.orderNumber, ...detail } },
    },
  };
}

export function planReview(order: ReviewOrder, action: ReviewAction): PlanResult {
  switch (action.kind) {
    case 'mark_item_delivered':
    case 'mark_item_not_delivered': {
      const wrong = requireStatus(order, 'needs_review');
      if (wrong) return { ok: false, failure: wrong };

      const item = order.items.find((i) => i.id === action.itemId);
      if (!item) return fail('ITEM_NOT_FOUND', `No item ${action.itemId} on ${order.orderNumber}.`);

      // `sending` may be a call in flight right now; `succeeded` and
      // `provider_pending` have an answer already, or will get one by polling.
      if (!RESOLVABLE.has(item.status)) {
        return fail(
          'ITEM_NOT_RESOLVABLE',
          `Item #${item.sequence + 1} is ${item.status}; only unknown or failed items can be settled by hand.`,
        );
      }

      if (action.kind === 'mark_item_delivered') {
        const othersDone = order.items.every((i) => i.id === item.id || i.status === 'succeeded');
        return plan(
          order,
          othersDone ? 'completed' : 'needs_review',
          [{ itemId: item.id, expectedStatus: item.status, status: 'succeeded', resetAttempts: false }],
          'review.item_marked_delivered',
          { itemId: item.id, sequence: item.sequence, diamondsBase: item.diamondsBase, was: item.status },
        );
      }

      // The one action that can lead to spending money twice.
      if (item.status === 'unknown' && !action.confirmedNotCharged) {
        return fail(
          'NEEDS_CONFIRMATION',
          'Confirm in the provider panel that this recharge was NOT charged before sending it again.',
        );
      }

      return plan(
        order,
        'needs_review',
        [{ itemId: item.id, expectedStatus: item.status, status: 'queued', resetAttempts: true }],
        'review.item_marked_not_delivered',
        {
          itemId: item.id,
          sequence: item.sequence,
          diamondsBase: item.diamondsBase,
          was: item.status,
          previousAttempts: item.attemptCount,
          confirmedNotCharged: action.confirmedNotCharged,
        },
      );
    }

    case 'resume': {
      const wrong = requireStatus(order, 'needs_review');
      if (wrong) return { ok: false, failure: wrong };

      const blocking = order.items.filter((i) => i.status === 'unknown' || i.status === 'sending');
      if (blocking.length > 0) {
        return fail(
          'UNRESOLVED_ITEMS',
          `Settle item(s) ${blocking.map((i) => `#${i.sequence + 1}`).join(', ')} first — ` +
            'resuming while an outcome is unknown could deliver twice.',
        );
      }

      const toSend = order.items.filter((i) => i.status === 'queued' || i.status === 'failed');
      if (toSend.length === 0) {
        return fail('NOTHING_TO_RESUME', `${order.orderNumber} has nothing left to send.`);
      }

      const delivered = order.items.some((i) => i.status === 'succeeded');
      return plan(
        order,
        // Both are states the worker claims from; which one only says whether
        // anything has reached the customer yet.
        delivered ? 'partially_delivered' : 'payment_confirmed',
        toSend.map((i) => ({
          itemId: i.id,
          expectedStatus: i.status,
          status: 'queued' as const,
          resetAttempts: true,
        })),
        'review.resumed',
        { items: toSend.map((i) => ({ sequence: i.sequence, was: i.status, attempts: i.attemptCount })) },
      );
    }

    case 'flag_refund': {
      const wrong = requireStatus(order, 'needs_review');
      if (wrong) return { ok: false, failure: wrong };

      const note = action.note.trim();
      if (note.length < 3) return fail('NOTE_REQUIRED', 'Say why the order is being refunded.');

      if (order.items.some((i) => i.status === 'sending')) {
        return fail('UNRESOLVED_ITEMS', 'A recharge is in flight; wait for it to settle.');
      }

      return plan(order, 'refund_required', [], 'review.refund_flagged', {
        note,
        deliveredItems: order.items.filter((i) => i.status === 'succeeded').length,
        totalItems: order.items.length,
      });
    }

    case 'refund_done': {
      const wrong = requireStatus(order, 'refund_required');
      if (wrong) return { ok: false, failure: wrong };

      const note = action.note.trim();
      if (note.length < 3) {
        return fail('NOTE_REQUIRED', 'Record how the refund was made (bank, amount, reference).');
      }

      return plan(order, 'cancelled', [], 'review.refund_done', { note });
    }
  }
}

export interface ReviewDeps {
  store: ReviewStore;
}

export type ReviewResult =
  | { ok: true; orderNumber: string; nextStatus: OrderStatus }
  | { ok: false; failure: ReviewFailure };

export async function applyReviewAction(
  deps: ReviewDeps,
  input: { orderId: string; adminUserId: string; action: ReviewAction },
): Promise<ReviewResult> {
  const order = await deps.store.loadForReview(input.orderId);
  if (!order) {
    return { ok: false, failure: { code: 'ORDER_NOT_FOUND', message: `No order ${input.orderId}.` } };
  }

  const planned = planReview(order, input.action);
  if (!planned.ok) return planned;

  try {
    await deps.store.applyReview(planned.plan, input.adminUserId);
  } catch (err) {
    if (err instanceof ReviewConflictError) {
      return { ok: false, failure: { code: 'CONFLICT', message: err.message } };
    }
    throw err;
  }

  return { ok: true, orderNumber: order.orderNumber, nextStatus: planned.plan.nextOrderStatus };
}
