import { describe, expect, it, vi } from 'vitest';
import {
  reportConversions,
  type ConversionOrder,
  type ConversionReporter,
  type ConversionStore,
  type ReportOutcome,
} from './conversions.js';

const NOW = new Date('2026-09-15T12:00:00Z');

const order = (overrides: Partial<ConversionOrder> = {}): ConversionOrder => ({
  orderId: 'order-1',
  orderNumber: 'LU-260915-AB12',
  eventId: '6f1c0b7e-0000-4000-8000-000000000001',
  comboKey: 'mega_10',
  priceMxnCents: 1_000,
  paidAt: new Date('2026-09-15T11:00:00Z'),
  playerId: '7288567050',
  contactEmail: null,
  contactWhatsapp: '5512345678',
  fbp: 'fb.1.1757000000000.123',
  fbc: null,
  clientIp: '189.1.2.3',
  userAgent: 'Mozilla/5.0',
  attempts: 0,
  ...overrides,
});

function harness(pending: ConversionOrder[], outcomes: ReportOutcome[]) {
  const store: ConversionStore = {
    findUnreported: vi.fn(async () => pending),
    markReported: vi.fn(async () => undefined),
    recordFailedAttempt: vi.fn(async () => undefined),
  };
  const reporter: ConversionReporter = {
    name: 'Meta CAPI',
    reportPurchase: vi.fn(async (): Promise<ReportOutcome> => outcomes.shift() ?? { ok: true }),
  };
  const alerter = { send: vi.fn(async () => undefined) };
  return { store, reporter, alerter, deps: { store, reporter, alerter, now: () => NOW } };
}

describe('reporting conversions', () => {
  it('reports each paid order once and marks it', async () => {
    const { deps, store, reporter } = harness([order(), order({ orderId: 'order-2' })], []);

    const result = await reportConversions(deps);

    expect(result).toEqual({ examined: 2, reported: 2, failed: 0, gaveUp: 0 });
    expect(reporter.reportPurchase).toHaveBeenCalledTimes(2);
    expect(store.markReported).toHaveBeenCalledWith('order-1', NOW);
    expect(store.markReported).toHaveBeenCalledWith('order-2', NOW);
  });

  it('only asks for orders inside Meta’s seven-day window', async () => {
    const { deps, store } = harness([], []);
    await reportConversions(deps);

    const { paidAfter } = vi.mocked(store.findUnreported).mock.calls[0]![0];
    const ageMs = NOW.getTime() - paidAfter.getTime();
    expect(ageMs).toBeLessThan(7 * 86_400_000);
    expect(ageMs).toBeGreaterThan(6.9 * 86_400_000);
  });

  it('counts a transient failure and tries again next sweep, without alerting', async () => {
    const { deps, store, alerter } = harness(
      [order({ attempts: 1 })],
      [{ ok: false, retryable: true, message: 'timeout' }],
    );

    const result = await reportConversions(deps);

    expect(result.failed).toBe(1);
    expect(store.recordFailedAttempt).toHaveBeenCalledWith('order-1');
    expect(store.markReported).not.toHaveBeenCalled();
    expect(alerter.send).not.toHaveBeenCalled();
  });

  it('gives up with one alert once the attempt budget is spent', async () => {
    const { deps, alerter } = harness(
      [order({ attempts: 4 })],
      [{ ok: false, retryable: true, message: 'Meta 500' }],
    );

    const result = await reportConversions(deps);

    expect(result.gaveUp).toBe(1);
    expect(alerter.send).toHaveBeenCalledTimes(1);
  });

  it('stops the batch on a permanent failure — a bad token fails every order alike', async () => {
    const { deps, reporter, alerter } = harness(
      [order(), order({ orderId: 'order-2' }), order({ orderId: 'order-3' })],
      [{ ok: false, retryable: false, message: 'Invalid OAuth access token' }],
    );

    await reportConversions(deps);

    expect(reporter.reportPurchase).toHaveBeenCalledTimes(1);
    expect(alerter.send).toHaveBeenCalledTimes(1);
  });

  it('treats a thrown reporter as a transient failure, never a crash', async () => {
    const { deps, store } = harness([order()], []);
    vi.mocked(deps.reporter.reportPurchase).mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(reportConversions(deps)).resolves.toMatchObject({ failed: 1 });
    expect(store.recordFailedAttempt).toHaveBeenCalled();
  });
});
