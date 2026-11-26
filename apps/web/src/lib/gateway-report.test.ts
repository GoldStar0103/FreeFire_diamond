import { describe, expect, it, vi, beforeEach } from 'vitest';

const attachGatewayCharge = vi.fn();
const extendPaymentDeadline = vi.fn();
const findGatewayPayment = vi.fn();
const findPaymentByOrderNumber = vi.fn();
const settleGatewayCharge = vi.fn();
const notifyOps = vi.fn();
const notifyGatewaySale = vi.fn();

vi.mock('@levelup/db', () => ({
  attachGatewayCharge: (...args: unknown[]) => attachGatewayCharge(...args),
  DrizzlePaymentStore: class {},
  extendPaymentDeadline: (...args: unknown[]) => extendPaymentDeadline(...args),
  findGatewayPayment: (...args: unknown[]) => findGatewayPayment(...args),
  findPaymentByOrderNumber: (...args: unknown[]) => findPaymentByOrderNumber(...args),
}));
vi.mock('@levelup/engine', () => ({
  settleGatewayCharge: (...args: unknown[]) => settleGatewayCharge(...args),
}));
vi.mock('./server', () => ({ getDb: () => 'fake-db' }));
vi.mock('./ops', () => ({ notifyOps: (...args: unknown[]) => notifyOps(...args) }));
vi.mock('./telegram', () => ({ notifyGatewaySale: (...args: unknown[]) => notifyGatewaySale(...args) }));
vi.mock('./format', () => ({ mxn: (cents: number) => `$${(cents / 100).toFixed(2)} MXN` }));

const { applyGatewayReport } = await import('./gateway-report');

const BASE_REPORT = {
  gatewayChargeId: 'ORD_1',
  amountReceivedCents: null,
  reference: 'ref-1',
  orderNumber: 'LU-260926-AB12',
  voucherIssued: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  settleGatewayCharge.mockResolvedValue({ action: 'ignored', reason: 'still pending' });
});

describe('applyGatewayReport — self-heal', () => {
  it('relinks a pending voucher report whose charge id was overwritten by a race', async () => {
    // Confirmed 2026-11-26: the real mechanism behind Jose's "some SPEI
    // payments don't link to the correct order" report — a pending voucher
    // report used to be dropped silently right here, so its deadline
    // extension never ran, and the order could expire before the eventual
    // `paid` report arrived.
    findGatewayPayment
      .mockResolvedValueOnce(null) // first lookup by charge id: miss
      .mockResolvedValueOnce({
        paymentId: 'pay-1',
        orderId: 'order-1',
        orderNumber: 'LU-260926-AB12',
        method: 'spei',
        comboName: 'Mini Pack',
        priceMxnCents: 1800,
      });
    findPaymentByOrderNumber.mockResolvedValue({
      orderId: 'order-1',
      orderNumber: 'LU-260926-AB12',
      paymentStatus: 'pending',
      gatewayChargeId: null,
    });
    attachGatewayCharge.mockResolvedValue(true);

    const result = await applyGatewayReport('mercadopago', { ...BASE_REPORT, state: 'pending', voucherIssued: true }, 3);

    expect(attachGatewayCharge).toHaveBeenCalledWith('fake-db', {
      orderId: 'order-1',
      gateway: 'mercadopago',
      gatewayChargeId: 'ORD_1',
      expiresAt: null,
    });
    expect(extendPaymentDeadline).toHaveBeenCalledWith('fake-db', 'pay-1', expect.any(Date));
    expect(notifyOps).not.toHaveBeenCalled();
    expect(result.paymentId).toBe('pay-1');
  });

  it('does not bother self-healing a pending report with no voucher — nothing would act on it anyway', async () => {
    findGatewayPayment.mockResolvedValue(null);

    const result = await applyGatewayReport('mercadopago', { ...BASE_REPORT, state: 'pending', voucherIssued: false }, 3);

    expect(findPaymentByOrderNumber).not.toHaveBeenCalled();
    expect(attachGatewayCharge).not.toHaveBeenCalled();
    expect(result).toEqual({ paymentId: null, orderNumber: null, settlement: null });
  });

  it('stays quiet when a pending voucher still cannot find a home — not money yet, the admin relink tool covers it', async () => {
    findGatewayPayment.mockResolvedValue(null);
    findPaymentByOrderNumber.mockResolvedValue(null);

    const result = await applyGatewayReport('mercadopago', { ...BASE_REPORT, state: 'pending', voucherIssued: true }, 3);

    expect(attachGatewayCharge).not.toHaveBeenCalled();
    expect(notifyOps).not.toHaveBeenCalled();
    expect(result).toEqual({ paymentId: null, orderNumber: null, settlement: null });
  });

  it('still alerts (not self-heals away) a paid report that already settled under a different charge', async () => {
    findGatewayPayment.mockResolvedValue(null);
    findPaymentByOrderNumber.mockResolvedValue({
      orderId: 'order-1',
      orderNumber: 'LU-260926-AB12',
      paymentStatus: 'paid',
      gatewayChargeId: 'ORD_OTHER',
    });

    const result = await applyGatewayReport(
      'mercadopago',
      { ...BASE_REPORT, state: 'paid', amountReceivedCents: 1800, voucherIssued: false },
      3,
    );

    expect(attachGatewayCharge).not.toHaveBeenCalled();
    expect(notifyOps).toHaveBeenCalledWith(
      'critical',
      'Pago DUPLICADO recibido — el pedido ya fue aprobado con otro cargo',
      expect.objectContaining({ pedido: 'LU-260926-AB12', cargoDuplicado: 'ORD_1', cargoYaAprobado: 'ORD_OTHER' }),
    );
    expect(result).toEqual({ paymentId: null, orderNumber: null, settlement: null });
  });

  it('does not self-heal a failed report — no money, and over-eagerly attaching it risks expiring the whole order', async () => {
    findGatewayPayment.mockResolvedValue(null);

    const result = await applyGatewayReport('mercadopago', { ...BASE_REPORT, state: 'failed', voucherIssued: false }, 3);

    expect(findPaymentByOrderNumber).not.toHaveBeenCalled();
    expect(attachGatewayCharge).not.toHaveBeenCalled();
    expect(notifyOps).not.toHaveBeenCalled();
    expect(result).toEqual({ paymentId: null, orderNumber: null, settlement: null });
  });
});
