import { describe, expect, it, vi } from 'vitest';
import { sendExpiryReminders, type ExpiringPayment, type ExpiryReminderStore } from './expiry-reminders.js';

const expiring = (n: number): ExpiringPayment[] =>
  Array.from({ length: n }, (_, i) => ({ orderId: `order-${i}`, orderNumber: `LU-00000${i}` }));

function harness(rows: ExpiringPayment[], send?: ExpiryReminderStore['sendReminder']) {
  const store: ExpiryReminderStore = {
    findExpiringPayments: vi.fn(async () => rows),
    sendReminder: send ?? vi.fn(async () => undefined),
  };
  return { store, deps: { store } };
}

describe('sendExpiryReminders', () => {
  it('reminds everything the query returned', async () => {
    const { store, deps } = harness(expiring(3));
    const result = await sendExpiryReminders(deps);

    expect(result).toEqual({ examined: 3, reminded: 3, failed: 0 });
    expect(store.sendReminder).toHaveBeenCalledTimes(3);
    expect(store.sendReminder).toHaveBeenCalledWith('order-0');
  });

  it('does nothing when nothing is close to expiring', async () => {
    const { store, deps } = harness([]);
    expect(await sendExpiryReminders(deps)).toEqual({ examined: 0, reminded: 0, failed: 0 });
    expect(store.sendReminder).not.toHaveBeenCalled();
  });

  it('keeps going after one row fails', async () => {
    const send = vi
      .fn<ExpiryReminderStore['sendReminder']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce(undefined);

    const { deps } = harness(expiring(3), send);
    expect(await sendExpiryReminders(deps)).toEqual({ examined: 3, reminded: 2, failed: 1 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('passes the default 30-minute window and batch size through', async () => {
    const { store, deps } = harness([]);
    await sendExpiryReminders(deps);
    expect(store.findExpiringPayments).toHaveBeenCalledWith(expect.any(Date), 30 * 60_000, 50);
  });

  it('lets a caller override the window and batch size', async () => {
    const { store, deps } = harness([]);
    await sendExpiryReminders({ ...deps, config: { windowMs: 15 * 60_000, batchSize: 5 } });
    expect(store.findExpiringPayments).toHaveBeenCalledWith(expect.any(Date), 15 * 60_000, 5);
  });

  it('uses the injected clock', async () => {
    const now = new Date('2026-09-09T12:00:00Z');
    const { store, deps } = harness([]);
    await sendExpiryReminders({ ...deps, now: () => now });
    expect(store.findExpiringPayments).toHaveBeenCalledWith(now, 30 * 60_000, 50);
  });

  it('decides nothing itself — the store owns which rows are eligible', async () => {
    const rows = expiring(2);
    const { store, deps } = harness(rows);
    await sendExpiryReminders(deps);

    const reminded = vi.mocked(store.sendReminder).mock.calls.map((c) => c[0]);
    expect(reminded).toEqual(rows.map((r) => r.orderId));
  });
});
