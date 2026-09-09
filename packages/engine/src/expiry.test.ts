import { describe, expect, it, vi } from 'vitest';
import { expireOverduePayments, type ExpiryStore, type OverduePayment } from './expiry.js';

const overdue = (n: number): OverduePayment[] =>
  Array.from({ length: n }, (_, i) => ({
    orderId: `order-${i}`,
    paymentId: `payment-${i}`,
    orderNumber: `LU-00000${i}`,
  }));

function harness(rows: OverduePayment[], expire?: ExpiryStore['expirePayment']) {
  const store: ExpiryStore = {
    findOverduePayments: vi.fn(async () => rows),
    expirePayment: expire ?? vi.fn(async () => undefined),
  };
  return { store, deps: { store, config: { batchSize: 25 } } };
}

describe('expireOverduePayments', () => {
  it('expires everything the query returned', async () => {
    const { store, deps } = harness(overdue(3));
    const result = await expireOverduePayments(deps);

    expect(result).toEqual({ examined: 3, expired: 3, failed: 0 });
    expect(store.expirePayment).toHaveBeenCalledTimes(3);
    expect(store.expirePayment).toHaveBeenCalledWith({
      orderId: 'order-0',
      paymentId: 'payment-0',
    });
  });

  it('does nothing when there is nothing overdue', async () => {
    const { store, deps } = harness([]);
    expect(await expireOverduePayments(deps)).toEqual({ examined: 0, expired: 0, failed: 0 });
    expect(store.expirePayment).not.toHaveBeenCalled();
  });

  it('keeps going after one row fails', async () => {
    // A Mega Oferta slot stays blocked until its order expires, so one bad row
    // must not hold up every other customer's.
    const expire = vi
      .fn<ExpiryStore['expirePayment']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce(undefined);

    const { deps } = harness(overdue(3), expire);
    expect(await expireOverduePayments(deps)).toEqual({ examined: 3, expired: 2, failed: 1 });
    expect(expire).toHaveBeenCalledTimes(3);
  });

  it('passes the batch size through, so a sweep cannot run away', async () => {
    const { store, deps } = harness([]);
    await expireOverduePayments({ ...deps, config: { batchSize: 5 } });
    expect(store.findOverduePayments).toHaveBeenCalledWith(expect.any(Date), 5);
  });

  it('uses the injected clock', async () => {
    const now = new Date('2026-09-09T12:00:00Z');
    const { store, deps } = harness([]);
    await expireOverduePayments({ ...deps, now: () => now });
    expect(store.findOverduePayments).toHaveBeenCalledWith(now, 25);
  });

  it('decides nothing itself — the store owns which rows are eligible', async () => {
    // The safety property lives in the query: a payment moves to under_review
    // the moment a comprobante is uploaded, and expiring one of those would
    // cancel an order somebody has already paid for. This function must not be
    // able to widen that, so it expires exactly what it is handed.
    const rows = overdue(2);
    const { store, deps } = harness(rows);
    await expireOverduePayments(deps);

    const expired = vi.mocked(store.expirePayment).mock.calls.map((c) => c[0].orderId);
    expect(expired).toEqual(rows.map((r) => r.orderId));
  });
});
