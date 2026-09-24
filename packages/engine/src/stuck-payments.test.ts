import { describe, expect, it, vi } from 'vitest';
import {
  alertStuckGatewayPayments,
  type StuckGatewayPayment,
  type StuckPaymentStore,
} from './stuck-payments.js';

const stuck = (n: number, method: 'oxxo' | 'spei' = 'oxxo'): StuckGatewayPayment[] =>
  Array.from({ length: n }, (_, i) => ({
    orderId: `order-${i}`,
    paymentId: `payment-${i}`,
    orderNumber: `LU-00000${i}`,
    method,
    amountExpectedCents: 1_800,
    pendingHours: 7,
  }));

type Send = (level: 'info' | 'warn' | 'critical', title: string, detail?: Record<string, unknown>) => Promise<void>;

function harness(rows: StuckGatewayPayment[], send?: Send) {
  const store: StuckPaymentStore = {
    findStuckGatewayPayments: vi.fn(async () => rows),
    markStuckAlertSent: vi.fn(async () => undefined),
  };
  const alerter = { send: vi.fn<Send>(send ?? (async () => undefined)) };
  return {
    store,
    alerter,
    deps: { store, alerter, config: { olderThanHours: 6, batchSize: 25 } },
  };
}

describe('alertStuckGatewayPayments', () => {
  it('alerts on everything the query returned and marks each one sent', async () => {
    const { store, alerter, deps } = harness(stuck(3));
    const result = await alertStuckGatewayPayments(deps);

    expect(result).toEqual({ examined: 3, alerted: 3, failed: 0 });
    expect(alerter.send).toHaveBeenCalledTimes(3);
    expect(store.markStuckAlertSent).toHaveBeenCalledTimes(3);
    expect(store.markStuckAlertSent).toHaveBeenCalledWith('payment-0');
  });

  it('names the order, method, and amount in the alert', async () => {
    const { alerter, deps } = harness(stuck(1, 'spei'));
    await alertStuckGatewayPayments(deps);

    const [level, title, detail] = alerter.send.mock.calls[0]!;
    expect(level).toBe('warn');
    expect(title).toContain('SPEI');
    expect(title).toContain('6h');
    expect(detail).toMatchObject({ order: 'LU-000000', method: 'spei', amountMxn: '18.00' });
  });

  it('does nothing when nothing is stuck', async () => {
    const { store, alerter, deps } = harness([]);
    expect(await alertStuckGatewayPayments(deps)).toEqual({ examined: 0, alerted: 0, failed: 0 });
    expect(alerter.send).not.toHaveBeenCalled();
    expect(store.markStuckAlertSent).not.toHaveBeenCalled();
  });

  it('does not mark a payment sent when the alert itself fails, so it retries next sweep', async () => {
    const { store, deps } = harness(stuck(2), () => {
      throw new Error('telegram down');
    });
    const result = await alertStuckGatewayPayments(deps);

    expect(result).toEqual({ examined: 2, alerted: 0, failed: 2 });
    expect(store.markStuckAlertSent).not.toHaveBeenCalled();
  });

  it('keeps going after one alert fails', async () => {
    const alerter = {
      send: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('telegram down'))
        .mockResolvedValueOnce(undefined),
    };
    const store: StuckPaymentStore = {
      findStuckGatewayPayments: vi.fn(async () => stuck(3)),
      markStuckAlertSent: vi.fn(async () => undefined),
    };
    const result = await alertStuckGatewayPayments({
      store,
      alerter,
      config: { olderThanHours: 6, batchSize: 25 },
    });

    expect(result).toEqual({ examined: 3, alerted: 2, failed: 1 });
    expect(store.markStuckAlertSent).toHaveBeenCalledTimes(2);
  });

  it('passes the cutoff computed from olderThanHours and the batch size through', async () => {
    const now = new Date('2026-09-24T02:00:00Z');
    const { store, deps } = harness([]);
    await alertStuckGatewayPayments({ ...deps, config: { olderThanHours: 6, batchSize: 10 }, now: () => now });

    expect(store.findStuckGatewayPayments).toHaveBeenCalledWith(new Date('2026-09-23T20:00:00Z'), 10);
  });
});
