import { describe, expect, it, vi } from 'vitest';
import { reconcilePendingItemOrders, type ItemReconcileDeps, type PendingItemOrder } from './item-reconcile.js';

const pending = (overrides: Partial<PendingItemOrder> = {}): PendingItemOrder => ({
  orderId: 'order-1',
  orderNumber: 'LU-261127-ZK91',
  rocketpassOrderId: 'rp-abc',
  attemptCount: 1,
  ...overrides,
});

function harness(listed: PendingItemOrder[]) {
  const store = {
    listPendingItemOrders: vi.fn(async () => listed),
    applyDecision: vi.fn(async () => undefined),
  };
  const alerter = { send: vi.fn(async () => undefined) };
  return { store, alerter };
}

const OPTIONS = { olderThanMs: 30_000, limit: 25 };
const CONFIG = { maxAttempts: 5 };

describe('reconcilePendingItemOrders', () => {
  it('settles an item order RocketPass already shows delivered, same gap as the Mercado Pago/Stripe webhook incidents', async () => {
    const { store, alerter } = harness([pending()]);
    const client = { getOrder: vi.fn(async () => ({ status: 'DELIVERED' as const })) };
    const deps: ItemReconcileDeps = { store, client, alerter, config: CONFIG };

    const result = await reconcilePendingItemOrders(deps, OPTIONS);

    expect(result).toEqual({ examined: 1, settled: 1, stillPending: 0, errored: 0 });
    expect(store.applyDecision).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({ itemStatus: 'delivered', orderStatus: 'completed', rocketpassOrderId: 'rp-abc' }),
    );
  });

  it('leaves an order alone while RocketPass still reports it pending or processing', async () => {
    const { store, alerter } = harness([pending()]);
    const client = { getOrder: vi.fn(async () => ({ status: 'PROCESSING' as const })) };
    const deps: ItemReconcileDeps = { store, client, alerter, config: CONFIG };

    const result = await reconcilePendingItemOrders(deps, OPTIONS);

    expect(result).toEqual({ examined: 1, settled: 0, stillPending: 1, errored: 0 });
    expect(store.applyDecision).not.toHaveBeenCalled();
  });

  it('settles a failed/partial/cancelled order into needs_review, with an alert, same as the webhook path', async () => {
    const { store, alerter } = harness([pending()]);
    const client = { getOrder: vi.fn(async () => ({ status: 'FAILED' as const })) };
    const deps: ItemReconcileDeps = { store, client, alerter, config: CONFIG };

    const result = await reconcilePendingItemOrders(deps, OPTIONS);

    expect(result).toEqual({ examined: 1, settled: 1, stillPending: 0, errored: 0 });
    expect(store.applyDecision).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({ itemStatus: 'failed', orderStatus: 'needs_review' }),
    );
    expect(alerter.send).toHaveBeenCalledWith('critical', expect.any(String), expect.objectContaining({ orderId: 'order-1' }));
  });

  it('keeps going after one order errors, same discipline as every other sweep step', async () => {
    const { store, alerter } = harness([
      pending({ orderId: 'order-1', rocketpassOrderId: 'rp-1' }),
      pending({ orderId: 'order-2', orderNumber: 'LU-261127-ZK92', rocketpassOrderId: 'rp-2' }),
    ]);
    const client = {
      getOrder: vi
        .fn()
        .mockRejectedValueOnce(new Error('RocketPass timed out'))
        .mockResolvedValueOnce({ status: 'DELIVERED' as const }),
    };
    const deps: ItemReconcileDeps = { store, client, alerter, config: CONFIG };

    const result = await reconcilePendingItemOrders(deps, OPTIONS);

    expect(result).toEqual({ examined: 2, settled: 1, stillPending: 0, errored: 1 });
  });

  it('does nothing when there is nothing pending', async () => {
    const { store, alerter } = harness([]);
    const client = { getOrder: vi.fn() };
    const deps: ItemReconcileDeps = { store, client, alerter, config: CONFIG };

    const result = await reconcilePendingItemOrders(deps, OPTIONS);

    expect(result).toEqual({ examined: 0, settled: 0, stillPending: 0, errored: 0 });
    expect(client.getOrder).not.toHaveBeenCalled();
  });

  it('passes the min age and batch size through to the store query', async () => {
    const { store, alerter } = harness([]);
    const deps: ItemReconcileDeps = { store, client: { getOrder: vi.fn() }, alerter, config: CONFIG };

    await reconcilePendingItemOrders(deps, { olderThanMs: 60_000, limit: 10 });

    expect(store.listPendingItemOrders).toHaveBeenCalledWith({ olderThanMs: 60_000, limit: 10 });
  });
});
