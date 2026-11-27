import { describe, expect, it, vi } from 'vitest';
import {
  ItemReviewConflictError,
  releaseItemOrderManually,
  retryItemOrderManually,
  type ItemReviewDeps,
  type ItemReviewOrder,
} from './item-review.js';

const order = (overrides: Partial<ItemReviewOrder> = {}): ItemReviewOrder => ({
  orderId: 'order-1',
  orderNumber: 'LU-261127-ZK91',
  orderStatus: 'processing',
  rocketpassOrderId: null,
  ...overrides,
});

function harness(found: ItemReviewOrder | null) {
  const store = {
    loadItemOrderForReview: vi.fn(async () => found),
    releaseItemOrderManually: vi.fn(async () => undefined),
    retryItemOrderManually: vi.fn(async () => undefined),
  };
  return store;
}

describe('releaseItemOrderManually', () => {
  it('completes a stuck processing order once the admin confirms it by hand', async () => {
    const store = harness(order({ orderStatus: 'processing' }));
    const deps: ItemReviewDeps = { store };

    const result = await releaseItemOrderManually(deps, {
      orderId: 'order-1',
      adminUserId: 'admin-1',
      note: 'Checked RocketPass portal, order rp-abc shows delivered',
    });

    expect(result).toEqual({ ok: true, orderNumber: 'LU-261127-ZK91' });
    expect(store.releaseItemOrderManually).toHaveBeenCalledWith({
      orderId: 'order-1',
      expectedOrderStatus: 'processing',
      adminUserId: 'admin-1',
      note: 'Checked RocketPass portal, order rp-abc shows delivered',
    });
  });

  it('completes a needs_review order the same way', async () => {
    const store = harness(order({ orderStatus: 'needs_review' }));
    const deps: ItemReviewDeps = { store };

    const result = await releaseItemOrderManually(deps, {
      orderId: 'order-1',
      adminUserId: 'admin-1',
      note: 'Confirmed with RocketPass support',
    });

    expect(result).toEqual({ ok: true, orderNumber: 'LU-261127-ZK91' });
  });

  it('refuses an order that does not exist', async () => {
    const store = harness(null);
    const deps: ItemReviewDeps = { store };

    const result = await releaseItemOrderManually(deps, { orderId: 'ghost', adminUserId: 'admin-1', note: 'x'.repeat(5) });

    expect(result).toEqual({ ok: false, failure: { code: 'ORDER_NOT_FOUND', message: 'No order ghost.' } });
  });

  it('refuses an order that is already completed', async () => {
    const store = harness(order({ orderStatus: 'completed' }));
    const deps: ItemReviewDeps = { store };

    const result = await releaseItemOrderManually(deps, { orderId: 'order-1', adminUserId: 'admin-1', note: 'x'.repeat(5) });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.code).toBe('ALREADY_RESOLVED');
    expect(store.releaseItemOrderManually).not.toHaveBeenCalled();
  });

  it('refuses an order still only payment_confirmed — not a legal direct jump to completed', async () => {
    const store = harness(order({ orderStatus: 'payment_confirmed' }));
    const deps: ItemReviewDeps = { store };

    const result = await releaseItemOrderManually(deps, { orderId: 'order-1', adminUserId: 'admin-1', note: 'x'.repeat(5) });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.code).toBe('ILLEGAL_TRANSITION');
  });

  it('requires a real note', async () => {
    const store = harness(order());
    const deps: ItemReviewDeps = { store };

    const result = await releaseItemOrderManually(deps, { orderId: 'order-1', adminUserId: 'admin-1', note: '  ' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.code).toBe('NOTE_REQUIRED');
    expect(store.releaseItemOrderManually).not.toHaveBeenCalled();
  });

  it('surfaces a conflict when the order moved under the admin', async () => {
    const store = harness(order());
    store.releaseItemOrderManually.mockRejectedValueOnce(new ItemReviewConflictError('moved'));
    const deps: ItemReviewDeps = { store };

    const result = await releaseItemOrderManually(deps, { orderId: 'order-1', adminUserId: 'admin-1', note: 'x'.repeat(5) });

    expect(result).toEqual({ ok: false, failure: { code: 'CONFLICT', message: 'moved' } });
  });
});

describe('retryItemOrderManually', () => {
  it('requeues a needs_review order RocketPass never actually created — the INSUFFICIENT_BALANCE case', async () => {
    const store = harness(order({ orderStatus: 'needs_review', rocketpassOrderId: null }));
    const deps: ItemReviewDeps = { store };

    const result = await retryItemOrderManually(deps, {
      orderId: 'order-1',
      adminUserId: 'admin-1',
      note: 'Topped up the RocketPass balance, safe to retry',
    });

    expect(result).toEqual({ ok: true, orderNumber: 'LU-261127-ZK91' });
    expect(store.retryItemOrderManually).toHaveBeenCalledWith({
      orderId: 'order-1',
      expectedOrderStatus: 'needs_review',
      adminUserId: 'admin-1',
      note: 'Topped up the RocketPass balance, safe to retry',
    });
  });

  it('refuses an order that is not needs_review', async () => {
    const store = harness(order({ orderStatus: 'processing', rocketpassOrderId: null }));
    const deps: ItemReviewDeps = { store };

    const result = await retryItemOrderManually(deps, { orderId: 'order-1', adminUserId: 'admin-1', note: 'x'.repeat(5) });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.code).toBe('ILLEGAL_TRANSITION');
    expect(store.retryItemOrderManually).not.toHaveBeenCalled();
  });

  it('refuses an order RocketPass already has on file — that one needs release, not retry', async () => {
    const store = harness(order({ orderStatus: 'needs_review', rocketpassOrderId: 'ORD-ABC123' }));
    const deps: ItemReviewDeps = { store };

    const result = await retryItemOrderManually(deps, { orderId: 'order-1', adminUserId: 'admin-1', note: 'x'.repeat(5) });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.code).toBe('NOT_RETRYABLE');
    expect(store.retryItemOrderManually).not.toHaveBeenCalled();
  });

  it('refuses an order that does not exist', async () => {
    const store = harness(null);
    const deps: ItemReviewDeps = { store };

    const result = await retryItemOrderManually(deps, { orderId: 'ghost', adminUserId: 'admin-1', note: 'x'.repeat(5) });

    expect(result).toEqual({ ok: false, failure: { code: 'ORDER_NOT_FOUND', message: 'No order ghost.' } });
  });

  it('requires a real note', async () => {
    const store = harness(order({ orderStatus: 'needs_review', rocketpassOrderId: null }));
    const deps: ItemReviewDeps = { store };

    const result = await retryItemOrderManually(deps, { orderId: 'order-1', adminUserId: 'admin-1', note: ' ' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.code).toBe('NOTE_REQUIRED');
    expect(store.retryItemOrderManually).not.toHaveBeenCalled();
  });

  it('surfaces a conflict when the order moved under the admin', async () => {
    const store = harness(order({ orderStatus: 'needs_review', rocketpassOrderId: null }));
    store.retryItemOrderManually.mockRejectedValueOnce(new ItemReviewConflictError('moved'));
    const deps: ItemReviewDeps = { store };

    const result = await retryItemOrderManually(deps, { orderId: 'order-1', adminUserId: 'admin-1', note: 'x'.repeat(5) });

    expect(result).toEqual({ ok: false, failure: { code: 'CONFLICT', message: 'moved' } });
  });
});
