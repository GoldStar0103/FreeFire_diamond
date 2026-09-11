import { describe, expect, it, vi } from 'vitest';
import {
  approvePayment,
  expireUnpaid,
  rejectPayment,
  settleGatewayCharge,
  type PayableOrder,
  type PaymentState,
  type PaymentStore,
} from './payments.js';

const NOW = new Date('2026-09-15T12:00:00Z');

const payable = (overrides: Partial<PayableOrder> = {}): PayableOrder => ({
  orderId: 'order-1',
  orderNumber: 'LU-260915-AB12',
  orderStatus: 'pending_payment',
  paymentId: 'pay-1',
  paymentStatus: 'pending',
  method: 'transfer_manual',
  amountExpectedCents: 153_000, // $1,530 â€” the pack from the client's WhatsApp log
  expiresAt: null,
  ...overrides,
});

function harness(order: PayableOrder | null) {
  const store: PaymentStore = {
    findPayable: vi.fn(async () => order),
    confirmPayment: vi.fn(async () => undefined),
    flagMismatch: vi.fn(async () => undefined),
    rejectPayment: vi.fn(async () => undefined),
    expirePayment: vi.fn(async () => undefined),
  };
  return { store, deps: { store, now: () => NOW } };
}

describe('approving a comprobante', () => {
  it('confirms the payment, which is what enqueues fulfilment', async () => {
    const { deps, store } = harness(payable());

    const result = await approvePayment(deps, {
      orderId: 'order-1',
      amountReceivedCents: 153_000,
      adminUserId: 'admin-1',
    });

    expect(result).toMatchObject({ ok: true, alreadyApproved: false });
    expect(store.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-1',
        paymentId: 'pay-1',
        amountReceivedCents: 153_000,
        adminUserId: 'admin-1',
        acceptedMismatch: false,
      }),
    );
  });

  it('assumes the exact amount when none is supplied', async () => {
    // A gateway webhook guarantees the amount; a human typing it does not.
    const { deps, store } = harness(payable());

    await approvePayment(deps, { orderId: 'order-1' });

    expect(store.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountReceivedCents: 153_000 }),
    );
  });

  it('is idempotent â€” a double tap does not enqueue twice', async () => {
    const { deps, store } = harness(payable({ paymentStatus: 'paid' }));

    const result = await approvePayment(deps, { orderId: 'order-1' });

    expect(result).toMatchObject({ ok: true, alreadyApproved: true });
    expect(store.confirmPayment).not.toHaveBeenCalled();
  });

  it('can approve a payment previously flagged as mismatched', async () => {
    // The admin looked at the receipt and decided it was fine.
    const { deps, store } = harness(payable({ paymentStatus: 'amount_mismatch' }));

    const result = await approvePayment(deps, {
      orderId: 'order-1',
      amountReceivedCents: 152_000,
      acceptMismatch: true,
      adminUserId: 'admin-1',
    });

    expect(result.ok).toBe(true);
    expect(store.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ acceptedMismatch: true, amountReceivedCents: 152_000 }),
    );
  });

  it.each<PaymentState>(['expired', 'failed'])('refuses a %s payment', async (paymentStatus) => {
    const { deps, store } = harness(payable({ paymentStatus }));

    expect(await approvePayment(deps, { orderId: 'order-1' })).toMatchObject({
      failure: { code: 'NOT_AWAITING_PAYMENT', paymentStatus },
    });
    expect(store.confirmPayment).not.toHaveBeenCalled();
  });

  it('fails cleanly for an unknown order', async () => {
    const { deps } = harness(null);
    expect(await approvePayment(deps, { orderId: 'nope' })).toMatchObject({
      failure: { code: 'ORDER_NOT_FOUND' },
    });
  });
});

describe('amount mismatch', () => {
  it('never fulfils on a short payment', async () => {
    // SPEI to a per-order CLABE can arrive for any amount, and diamonds shipped
    // against a short payment cannot be recovered.
    const { deps, store } = harness(payable());

    const result = await approvePayment(deps, {
      orderId: 'order-1',
      amountReceivedCents: 100_000,
      adminUserId: 'admin-1',
    });

    expect(result).toMatchObject({
      failure: { code: 'AMOUNT_MISMATCH', expectedCents: 153_000, receivedCents: 100_000 },
    });
    expect(store.confirmPayment).not.toHaveBeenCalled();
    expect(store.flagMismatch).toHaveBeenCalledWith(
      expect.objectContaining({ amountReceivedCents: 100_000 }),
    );
  });

  it('also flags an overpayment rather than silently absorbing it', async () => {
    const { deps, store } = harness(payable());

    const result = await approvePayment(deps, {
      orderId: 'order-1',
      amountReceivedCents: 200_000,
    });

    expect(result.ok).toBe(false);
    expect(store.flagMismatch).toHaveBeenCalled();
  });

  it('proceeds when an admin deliberately overrides', async () => {
    const { deps, store } = harness(payable());

    const result = await approvePayment(deps, {
      orderId: 'order-1',
      amountReceivedCents: 152_500,
      acceptMismatch: true,
      adminUserId: 'admin-1',
    });

    expect(result.ok).toBe(true);
    // Recorded as an override so the decision stays attributable.
    expect(store.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ acceptedMismatch: true, adminUserId: 'admin-1' }),
    );
  });
});

describe('expiry', () => {
  it('refuses an OXXO voucher paid after the window closed', async () => {
    // The promo may have rotated; the snapshot may no longer match what is sold.
    const { deps, store } = harness(
      payable({ expiresAt: new Date('2026-09-14T12:00:00Z') }),
    );

    expect(await approvePayment(deps, { orderId: 'order-1' })).toMatchObject({
      failure: { code: 'PAYMENT_EXPIRED' },
    });
    expect(store.confirmPayment).not.toHaveBeenCalled();
  });

  it('lets an admin honour a late payment anyway', async () => {
    const { deps, store } = harness(
      payable({ expiresAt: new Date('2026-09-14T12:00:00Z') }),
    );

    const result = await approvePayment(deps, { orderId: 'order-1', acceptMismatch: true });

    expect(result.ok).toBe(true);
    expect(store.confirmPayment).toHaveBeenCalled();
  });

  it('accepts a payment still inside its window', async () => {
    const { deps } = harness(payable({ expiresAt: new Date('2026-09-16T12:00:00Z') }));
    expect((await approvePayment(deps, { orderId: 'order-1' })).ok).toBe(true);
  });

  it('expires an unpaid order past its window', async () => {
    const { deps, store } = harness(payable({ expiresAt: new Date('2026-09-14T12:00:00Z') }));
    expect(await expireUnpaid(deps, 'order-1')).toEqual({ expired: true });
    expect(store.expirePayment).toHaveBeenCalled();
  });

  it('leaves an order that was paid while the sweep ran', async () => {
    const { deps, store } = harness(
      payable({ paymentStatus: 'paid', expiresAt: new Date('2026-09-14T12:00:00Z') }),
    );
    expect(await expireUnpaid(deps, 'order-1')).toEqual({ expired: false });
    expect(store.expirePayment).not.toHaveBeenCalled();
  });

  it('leaves an order with no expiry at all', async () => {
    const { deps, store } = harness(payable({ expiresAt: null }));
    expect(await expireUnpaid(deps, 'order-1')).toEqual({ expired: false });
    expect(store.expirePayment).not.toHaveBeenCalled();
  });
});

describe('rejection', () => {
  it('rejects an unpaid order', async () => {
    const { deps, store } = harness(payable());

    const result = await rejectPayment(deps, {
      orderId: 'order-1',
      adminUserId: 'admin-1',
      reason: 'Comprobante ilegible',
    });

    expect(result.ok).toBe(true);
    expect(store.rejectPayment).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Comprobante ilegible' }),
    );
  });

  it('refuses to reject money that has already arrived', async () => {
    // That is a refund, which is a deliberately separate action.
    const { deps, store } = harness(payable({ paymentStatus: 'paid' }));

    expect(
      await rejectPayment(deps, { orderId: 'order-1', reason: 'changed mind' }),
    ).toMatchObject({ failure: { code: 'NOT_AWAITING_PAYMENT' } });
    expect(store.rejectPayment).not.toHaveBeenCalled();
  });
});

describe('settling a gateway charge', () => {
  const card = (overrides: Partial<PayableOrder> = {}) =>
    payable({ method: 'card', amountExpectedCents: 26_000, ...overrides });

  it('approves a paid card charge through the same path as a comprobante', async () => {
    const { deps, store } = harness(card());

    const result = await settleGatewayCharge(deps, {
      orderId: 'order-1',
      state: 'paid',
      amountReceivedCents: 26_000,
      reference: 'pi_123',
    });

    expect(result).toEqual({ action: 'approved', orderNumber: 'LU-260915-AB12' });
    expect(store.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountReceivedCents: 26_000, adminUserId: null, reference: 'pi_123' }),
    );
  });

  it('turns a redelivered webhook into a no-op, not a second enqueue', async () => {
    const { deps, store } = harness(card({ paymentStatus: 'paid' }));

    const result = await settleGatewayCharge(deps, {
      orderId: 'order-1',
      state: 'paid',
      amountReceivedCents: 26_000,
      reference: 'pi_123',
    });

    expect(result.action).toBe('already_approved');
    expect(store.confirmPayment).not.toHaveBeenCalled();
  });

  it('refuses â€” and does not ship â€” when the gateway amount differs', async () => {
    const { deps, store } = harness(card());

    const result = await settleGatewayCharge(deps, {
      orderId: 'order-1',
      state: 'paid',
      amountReceivedCents: 1_000,
      reference: 'pi_123',
    });

    expect(result).toMatchObject({ action: 'refused', failure: { code: 'AMOUNT_MISMATCH' } });
    expect(store.confirmPayment).not.toHaveBeenCalled();
    expect(store.flagMismatch).toHaveBeenCalled();
  });

  it('refuses a paid report that carries no amount', async () => {
    const { deps, store } = harness(card());

    const result = await settleGatewayCharge(deps, {
      orderId: 'order-1',
      state: 'paid',
      amountReceivedCents: null,
      reference: null,
    });

    expect(result.action).toBe('refused');
    expect(store.confirmPayment).not.toHaveBeenCalled();
  });

  it('refuses money that lands on an order already expired, so a human is told', async () => {
    const { deps } = harness(card({ paymentStatus: 'expired', orderStatus: 'payment_expired' }));

    const result = await settleGatewayCharge(deps, {
      orderId: 'order-1',
      state: 'paid',
      amountReceivedCents: 26_000,
      reference: 'pi_123',
    });

    expect(result).toMatchObject({ action: 'refused', failure: { code: 'NOT_AWAITING_PAYMENT' } });
  });

  it('expires an abandoned checkout, which frees a Mega Oferta slot', async () => {
    const { deps, store } = harness(card());

    const result = await settleGatewayCharge(deps, {
      orderId: 'order-1',
      state: 'expired',
      amountReceivedCents: null,
      reference: null,
    });

    expect(result.action).toBe('expired');
    expect(store.expirePayment).toHaveBeenCalledWith({ orderId: 'order-1', paymentId: 'pay-1' });
  });

  it('never expires a payment that has already been acted on', async () => {
    for (const paymentStatus of ['paid', 'under_review', 'amount_mismatch'] as PaymentState[]) {
      const { deps, store } = harness(card({ paymentStatus }));
      const result = await settleGatewayCharge(deps, {
        orderId: 'order-1',
        state: 'failed',
        amountReceivedCents: null,
        reference: null,
      });
      expect(result.action).toBe('ignored');
      expect(store.expirePayment).not.toHaveBeenCalled();
    }
  });

  it('leaves pending charges and refunds alone', async () => {
    for (const state of ['pending', 'refunded'] as const) {
      const { deps, store } = harness(card());
      const result = await settleGatewayCharge(deps, {
        orderId: 'order-1',
        state,
        amountReceivedCents: null,
        reference: null,
      });
      expect(result.action).toBe('ignored');
      expect(store.confirmPayment).not.toHaveBeenCalled();
      expect(store.expirePayment).not.toHaveBeenCalled();
    }
  });
});
