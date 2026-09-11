import { describe, expect, it, vi } from 'vitest';
import {
  applyReviewAction,
  planReview,
  ReviewConflictError,
  type ReviewItem,
  type ReviewOrder,
  type ReviewStore,
} from './review.js';
import type { OrderItemStatus, OrderStatus } from './states.js';

const item = (sequence: number, status: OrderItemStatus, attemptCount = 1): ReviewItem => ({
  id: `item-${sequence + 1}`,
  sequence,
  status,
  attemptCount,
  diamondsBase: 5600,
});

const order = (items: ReviewItem[], status: OrderStatus = 'needs_review'): ReviewOrder => ({
  id: 'order-1',
  orderNumber: 'LU-260910-AB12',
  status,
  items,
});

describe('marking a recharge delivered', () => {
  it('settles an unknown item and completes the order when it was the last one', () => {
    const result = planReview(order([item(0, 'succeeded'), item(1, 'unknown')]), {
      kind: 'mark_item_delivered',
      itemId: 'item-2',
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        expectedOrderStatus: 'needs_review',
        nextOrderStatus: 'completed',
        itemUpdates: [{ itemId: 'item-2', expectedStatus: 'unknown', status: 'succeeded' }],
      },
    });
  });

  it('leaves the order in review while other recharges are still missing', () => {
    // Mega Prime halted on call 3 of 8: settling #3 must not start spending on
    // 4–8 by itself. Resuming is a separate, deliberate click.
    const items = [item(0, 'succeeded'), item(1, 'succeeded'), item(2, 'unknown'), item(3, 'queued', 0)];
    const result = planReview(order(items), { kind: 'mark_item_delivered', itemId: 'item-3' });

    expect(result.ok && result.plan.nextOrderStatus).toBe('needs_review');
  });

  it('refuses an item that is in flight or already has an answer', () => {
    for (const status of ['sending', 'succeeded', 'provider_pending', 'queued'] as OrderItemStatus[]) {
      const result = planReview(order([item(0, status)]), { kind: 'mark_item_delivered', itemId: 'item-1' });
      expect(result).toMatchObject({ ok: false, failure: { code: 'ITEM_NOT_RESOLVABLE' } });
    }
  });

  it('refuses when the order is not under review', () => {
    const result = planReview(order([item(0, 'unknown')], 'processing'), {
      kind: 'mark_item_delivered',
      itemId: 'item-1',
    });
    expect(result).toMatchObject({ ok: false, failure: { code: 'WRONG_ORDER_STATUS' } });
  });
});

describe('marking a recharge not delivered', () => {
  it('will not re-queue an unknown outcome without the admin confirming it was not charged', () => {
    // The one click that could deliver twice.
    const result = planReview(order([item(0, 'unknown')]), {
      kind: 'mark_item_not_delivered',
      itemId: 'item-1',
      confirmedNotCharged: false,
    });
    expect(result).toMatchObject({ ok: false, failure: { code: 'NEEDS_CONFIRMATION' } });
  });

  it('re-queues it with a fresh retry budget once confirmed, without resuming the order', () => {
    const result = planReview(order([item(0, 'unknown', 3)]), {
      kind: 'mark_item_not_delivered',
      itemId: 'item-1',
      confirmedNotCharged: true,
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        nextOrderStatus: 'needs_review',
        itemUpdates: [{ status: 'queued', resetAttempts: true, expectedStatus: 'unknown' }],
        audit: { detail: { previousAttempts: 3, confirmedNotCharged: true } },
      },
    });
  });

  it('needs no confirmation for a definite failure — nothing was charged by definition', () => {
    const result = planReview(order([item(0, 'failed', 3)]), {
      kind: 'mark_item_not_delivered',
      itemId: 'item-1',
      confirmedNotCharged: false,
    });
    expect(result.ok).toBe(true);
  });
});

describe('resuming', () => {
  it('re-enqueues an order paused for a low wallet', () => {
    const result = planReview(order([item(0, 'queued', 0), item(1, 'queued', 0)]), { kind: 'resume' });

    expect(result).toMatchObject({
      ok: true,
      plan: { nextOrderStatus: 'payment_confirmed' },
    });
  });

  it('resends exhausted failures with a fresh budget, and says the order is partly delivered', () => {
    const result = planReview(order([item(0, 'succeeded'), item(1, 'failed', 3)]), { kind: 'resume' });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        nextOrderStatus: 'partially_delivered',
        itemUpdates: [{ itemId: 'item-2', expectedStatus: 'failed', status: 'queued', resetAttempts: true }],
      },
    });
  });

  it('refuses while any outcome is unknown or a call is in flight', () => {
    for (const status of ['unknown', 'sending'] as OrderItemStatus[]) {
      const result = planReview(order([item(0, status), item(1, 'queued', 0)]), { kind: 'resume' });
      expect(result).toMatchObject({ ok: false, failure: { code: 'UNRESOLVED_ITEMS' } });
    }
  });

  it('refuses when there is nothing left to send', () => {
    const result = planReview(order([item(0, 'succeeded'), item(1, 'provider_pending')]), { kind: 'resume' });
    expect(result).toMatchObject({ ok: false, failure: { code: 'NOTHING_TO_RESUME' } });
  });
});

describe('refunds', () => {
  it('flags a reviewed order for refund, with a reason', () => {
    const result = planReview(order([item(0, 'failed', 3)]), { kind: 'flag_refund', note: 'Cuenta baneada' });
    expect(result).toMatchObject({ ok: true, plan: { nextOrderStatus: 'refund_required' } });
  });

  it('refuses a refund without a reason, or while a call is in flight', () => {
    expect(planReview(order([item(0, 'failed')]), { kind: 'flag_refund', note: ' ' })).toMatchObject({
      failure: { code: 'NOTE_REQUIRED' },
    });
    expect(planReview(order([item(0, 'sending')]), { kind: 'flag_refund', note: 'motivo' })).toMatchObject({
      failure: { code: 'UNRESOLVED_ITEMS' },
    });
  });

  it('closes the order once the refund is recorded', () => {
    const result = planReview(order([item(0, 'failed')], 'refund_required'), {
      kind: 'refund_done',
      note: 'SPEI $1,530 ref 123456',
    });
    expect(result).toMatchObject({ ok: true, plan: { nextOrderStatus: 'cancelled' } });
  });

  it('only closes orders that were flagged for refund', () => {
    const result = planReview(order([item(0, 'failed')]), { kind: 'refund_done', note: 'hecho' });
    expect(result).toMatchObject({ ok: false, failure: { code: 'WRONG_ORDER_STATUS' } });
  });
});

describe('applyReviewAction', () => {
  function harness(loaded: ReviewOrder | null) {
    const store: ReviewStore = {
      loadForReview: vi.fn(async () => loaded),
      applyReview: vi.fn(async () => undefined),
    };
    return { store };
  }

  it('commits the plan attributed to the admin', async () => {
    const { store } = harness(order([item(0, 'unknown')]));

    const result = await applyReviewAction(
      { store },
      { orderId: 'order-1', adminUserId: 'admin-1', action: { kind: 'mark_item_delivered', itemId: 'item-1' } },
    );

    expect(result).toEqual({ ok: true, orderNumber: 'LU-260910-AB12', nextStatus: 'completed' });
    expect(store.applyReview).toHaveBeenCalledWith(
      expect.objectContaining({ audit: expect.objectContaining({ action: 'review.item_marked_delivered' }) }),
      'admin-1',
    );
  });

  it('does not write when the plan is refused', async () => {
    const { store } = harness(order([item(0, 'unknown')]));
    await applyReviewAction(
      { store },
      { orderId: 'order-1', adminUserId: 'admin-1', action: { kind: 'resume' } },
    );
    expect(store.applyReview).not.toHaveBeenCalled();
  });

  it('turns a store conflict into a failure the panel can show', async () => {
    const { store } = harness(order([item(0, 'unknown')]));
    vi.mocked(store.applyReview).mockRejectedValueOnce(new ReviewConflictError('moved'));

    const result = await applyReviewAction(
      { store },
      { orderId: 'order-1', adminUserId: 'admin-1', action: { kind: 'mark_item_delivered', itemId: 'item-1' } },
    );
    expect(result).toMatchObject({ ok: false, failure: { code: 'CONFLICT' } });
  });

  it('reports a missing order', async () => {
    const { store } = harness(null);
    const result = await applyReviewAction(
      { store },
      { orderId: 'nope', adminUserId: 'admin-1', action: { kind: 'resume' } },
    );
    expect(result).toMatchObject({ ok: false, failure: { code: 'ORDER_NOT_FOUND' } });
  });
});
