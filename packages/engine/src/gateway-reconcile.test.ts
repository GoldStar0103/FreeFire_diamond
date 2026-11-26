import { describe, expect, it, vi } from 'vitest';
import { reconcilePendingGatewayPayments, type GatewayReconcileDeps, type PendingGatewayPayment } from './gateway-reconcile.js';
import type { PayableOrder } from './payments.js';

const pending = (overrides: Partial<PendingGatewayPayment> = {}): PendingGatewayPayment => ({
  paymentId: 'pay-1',
  orderId: 'order-1',
  orderNumber: 'LU-261126-AB12',
  gatewayChargeId: 'LU-261126-AB12',
  ...overrides,
});

const payable = (overrides: Partial<PayableOrder> = {}): PayableOrder => ({
  orderId: 'order-1',
  orderNumber: 'LU-261126-AB12',
  orderStatus: 'pending_payment',
  paymentId: 'pay-1',
  paymentStatus: 'pending',
  method: 'card',
  amountExpectedCents: 86_000,
  expiresAt: null,
  ...overrides,
});

function harness(listed: PendingGatewayPayment[], payableOrder: PayableOrder | null) {
  const store = {
    listPendingGatewayPayments: vi.fn(async () => listed),
    findPayable: vi.fn(async () => payableOrder),
    confirmPayment: vi.fn(async () => undefined),
    flagMismatch: vi.fn(async () => undefined),
    rejectPayment: vi.fn(async () => undefined),
    expirePayment: vi.fn(async () => undefined),
  };
  return store;
}

const OPTIONS = { gatewayName: 'mercadopago', olderThanMs: 30_000, limit: 25 };

describe('reconcilePendingGatewayPayments', () => {
  it('settles a payment Mercado Pago already shows as paid — confirmed in production, 2026-11-26', async () => {
    // Real incident: Checkout Pro's own webhook never reached the app at all,
    // so a customer who paid and never reloaded their order page had no path
    // to ever get their diamonds. This sweep is that path.
    const store = harness([pending()], payable());
    const gateway = { getCharge: vi.fn(async () => ({ state: 'paid' as const, amountReceivedCents: 86_000, reference: 'mp-ref-1' })) };
    const deps: GatewayReconcileDeps = { store, gateway };

    const result = await reconcilePendingGatewayPayments(deps, OPTIONS);

    expect(result).toEqual({ examined: 1, settled: 1, stillPending: 0, errored: 0 });
    expect(store.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', paymentId: 'pay-1', amountReceivedCents: 86_000 }),
    );
  });

  it('leaves a payment alone while Mercado Pago still reports it pending (e.g. in_mediation)', async () => {
    // Real case found alongside the bug above: a payment under Mercado
    // Pago's own fraud/dispute review (in_mediation) must not be force-
    // released just because a customer's own receipt said "Aprobado" —
    // `paymentState()`'s mapping already reduces that to 'pending' here,
    // and this sweep must respect that, not second-guess it.
    const store = harness([pending()], payable());
    const gateway = { getCharge: vi.fn(async () => ({ state: 'pending' as const, amountReceivedCents: null, reference: null })) };
    const deps: GatewayReconcileDeps = { store, gateway };

    const result = await reconcilePendingGatewayPayments(deps, OPTIONS);

    expect(result).toEqual({ examined: 1, settled: 0, stillPending: 1, errored: 0 });
    expect(store.confirmPayment).not.toHaveBeenCalled();
  });

  it('settles a declined card as failed/expired, not stuck forever either', async () => {
    const store = harness([pending()], payable());
    const gateway = { getCharge: vi.fn(async () => ({ state: 'failed' as const, amountReceivedCents: null, reference: null })) };
    const deps: GatewayReconcileDeps = { store, gateway };

    const result = await reconcilePendingGatewayPayments(deps, OPTIONS);

    expect(result).toEqual({ examined: 1, settled: 1, stillPending: 0, errored: 0 });
    expect(store.expirePayment).toHaveBeenCalledWith({ orderId: 'order-1', paymentId: 'pay-1' });
  });

  it('keeps going after one payment errors, same discipline as every other sweep step', async () => {
    const store = harness([pending({ paymentId: 'pay-1', orderId: 'order-1' }), pending({ paymentId: 'pay-2', orderId: 'order-2', gatewayChargeId: 'LU-261126-ZZ99' })], payable());
    const gateway = {
      getCharge: vi
        .fn()
        .mockRejectedValueOnce(new Error('Mercado Pago timed out'))
        .mockResolvedValueOnce({ state: 'paid' as const, amountReceivedCents: 86_000, reference: 'mp-ref-2' }),
    };
    const deps: GatewayReconcileDeps = { store, gateway };

    const result = await reconcilePendingGatewayPayments(deps, OPTIONS);

    expect(result).toEqual({ examined: 2, settled: 1, stillPending: 0, errored: 1 });
  });

  it('does nothing when there is nothing pending', async () => {
    const store = harness([], payable());
    const gateway = { getCharge: vi.fn() };
    const deps: GatewayReconcileDeps = { store, gateway };

    const result = await reconcilePendingGatewayPayments(deps, OPTIONS);

    expect(result).toEqual({ examined: 0, settled: 0, stillPending: 0, errored: 0 });
    expect(gateway.getCharge).not.toHaveBeenCalled();
  });

  it('passes the gateway name, min age, and batch size through to the store query', async () => {
    const store = harness([], payable());
    const deps: GatewayReconcileDeps = { store, gateway: { getCharge: vi.fn() } };

    await reconcilePendingGatewayPayments(deps, { gatewayName: 'mercadopago', olderThanMs: 60_000, limit: 10 });

    expect(store.listPendingGatewayPayments).toHaveBeenCalledWith({
      gateway: 'mercadopago',
      olderThanMs: 60_000,
      limit: 10,
    });
  });
});
