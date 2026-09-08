/**
 * Payment decisions.
 *
 * Approving a payment is the moment an order becomes fulfillable — there is no
 * separate queue, so writing `payment_confirmed` *is* the enqueue. That makes
 * this the highest-consequence write in the system: get it wrong and either a
 * customer pays and receives nothing, or diamonds ship for money that never
 * arrived.
 *
 * The launch flow is the one LevelUp already runs by hand: the customer
 * transfers to BBVA or deposits at OXXO and sends a photo of the receipt. An
 * admin approves it here in one tap, and fulfilment happens automatically.
 * Conekta later replaces the human with a webhook calling the same function.
 */

export type PaymentMethod = 'transfer_manual' | 'spei' | 'oxxo' | 'card' | 'paypal';

export type PaymentState =
  | 'pending'
  | 'under_review'
  | 'paid'
  | 'expired'
  | 'failed'
  | 'amount_mismatch';

export interface PayableOrder {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  paymentId: string;
  paymentStatus: PaymentState;
  method: PaymentMethod;
  amountExpectedCents: number;
  expiresAt: Date | null;
}

export interface ApprovePaymentInput {
  orderId: string;
  /** What actually arrived. Omit when the gateway guarantees the exact amount. */
  amountReceivedCents?: number;
  /** Null for a gateway webhook; set for a human approving a comprobante. */
  adminUserId?: string | null;
  reference?: string | null;
  /**
   * Accept a mismatched amount anyway. A deliberate, attributable override —
   * the client sometimes lets a few pesos short go through for a regular.
   */
  acceptMismatch?: boolean;
}

export type PaymentFailure =
  | { code: 'ORDER_NOT_FOUND'; message: string }
  | { code: 'NOT_AWAITING_PAYMENT'; message: string; paymentStatus: PaymentState }
  | { code: 'PAYMENT_EXPIRED'; message: string }
  | {
      code: 'AMOUNT_MISMATCH';
      message: string;
      expectedCents: number;
      receivedCents: number;
    };

export type PaymentResult =
  | { ok: true; orderId: string; orderNumber: string; alreadyApproved: boolean }
  | { ok: false; failure: PaymentFailure };

export interface PaymentStore {
  findPayable(orderId: string): Promise<PayableOrder | null>;
  /** Payment -> paid and order -> payment_confirmed, in one transaction. */
  confirmPayment(input: {
    orderId: string;
    paymentId: string;
    amountReceivedCents: number;
    adminUserId: string | null;
    reference: string | null;
    acceptedMismatch: boolean;
  }): Promise<void>;
  flagMismatch(input: {
    orderId: string;
    paymentId: string;
    amountReceivedCents: number;
    adminUserId: string | null;
  }): Promise<void>;
  rejectPayment(input: {
    orderId: string;
    paymentId: string;
    adminUserId: string | null;
    reason: string;
  }): Promise<void>;
  expirePayment(input: { orderId: string; paymentId: string }): Promise<void>;
}

export interface PaymentDeps {
  store: PaymentStore;
  now?: () => Date;
}

/** Payment states from which approval is still meaningful. */
const AWAITING: ReadonlySet<PaymentState> = new Set<PaymentState>([
  'pending',
  'under_review',
  'amount_mismatch',
]);

export async function approvePayment(
  deps: PaymentDeps,
  input: ApprovePaymentInput,
): Promise<PaymentResult> {
  const now = deps.now?.() ?? new Date();
  const fail = (failure: PaymentFailure): PaymentResult => ({ ok: false, failure });

  const payable = await deps.store.findPayable(input.orderId);
  if (!payable) {
    return fail({ code: 'ORDER_NOT_FOUND', message: `No order ${input.orderId}.` });
  }

  // Idempotent by design. An admin double-tapping "aprobar" on a slow phone
  // connection, or a gateway redelivering a webhook, must not enqueue twice.
  if (payable.paymentStatus === 'paid') {
    return {
      ok: true,
      orderId: payable.orderId,
      orderNumber: payable.orderNumber,
      alreadyApproved: true,
    };
  }

  if (!AWAITING.has(payable.paymentStatus)) {
    return fail({
      code: 'NOT_AWAITING_PAYMENT',
      message: `Payment for ${payable.orderNumber} is ${payable.paymentStatus}.`,
      paymentStatus: payable.paymentStatus,
    });
  }

  // An OXXO voucher paid after expiry needs a human: the promo may have rotated
  // and the recipe snapshot may no longer reflect what is on sale.
  if (payable.expiresAt && now > payable.expiresAt && !input.acceptMismatch) {
    return fail({
      code: 'PAYMENT_EXPIRED',
      message: `Payment window for ${payable.orderNumber} closed on ${payable.expiresAt.toISOString()}.`,
    });
  }

  const received = input.amountReceivedCents ?? payable.amountExpectedCents;

  if (received !== payable.amountExpectedCents && !input.acceptMismatch) {
    // Never fulfil on a mismatch. SPEI to a per-order CLABE can arrive for any
    // amount, and a short payment that ships diamonds is an unrecoverable loss.
    await deps.store.flagMismatch({
      orderId: payable.orderId,
      paymentId: payable.paymentId,
      amountReceivedCents: received,
      adminUserId: input.adminUserId ?? null,
    });

    return fail({
      code: 'AMOUNT_MISMATCH',
      message:
        `${payable.orderNumber} expected ${(payable.amountExpectedCents / 100).toFixed(2)} MXN ` +
        `but received ${(received / 100).toFixed(2)} MXN.`,
      expectedCents: payable.amountExpectedCents,
      receivedCents: received,
    });
  }

  await deps.store.confirmPayment({
    orderId: payable.orderId,
    paymentId: payable.paymentId,
    amountReceivedCents: received,
    adminUserId: input.adminUserId ?? null,
    reference: input.reference ?? null,
    acceptedMismatch: received !== payable.amountExpectedCents,
  });

  return {
    ok: true,
    orderId: payable.orderId,
    orderNumber: payable.orderNumber,
    alreadyApproved: false,
  };
}

export async function rejectPayment(
  deps: PaymentDeps,
  input: { orderId: string; adminUserId?: string | null; reason: string },
): Promise<PaymentResult> {
  const payable = await deps.store.findPayable(input.orderId);
  if (!payable) {
    return { ok: false, failure: { code: 'ORDER_NOT_FOUND', message: `No order ${input.orderId}.` } };
  }

  // Rejecting a paid order would strand money that has already arrived; that is
  // a refund, which is a different and deliberately separate action.
  if (payable.paymentStatus === 'paid') {
    return {
      ok: false,
      failure: {
        code: 'NOT_AWAITING_PAYMENT',
        message: `${payable.orderNumber} is already paid — use a refund, not a rejection.`,
        paymentStatus: payable.paymentStatus,
      },
    };
  }

  await deps.store.rejectPayment({
    orderId: payable.orderId,
    paymentId: payable.paymentId,
    adminUserId: input.adminUserId ?? null,
    reason: input.reason,
  });

  return {
    ok: true,
    orderId: payable.orderId,
    orderNumber: payable.orderNumber,
    alreadyApproved: false,
  };
}

/**
 * Expire an unpaid order. Driven by a cron, not a human.
 *
 * Only ever applies to orders still awaiting payment — an order that was paid
 * while the cron was mid-sweep must survive it.
 */
export async function expireUnpaid(
  deps: PaymentDeps,
  orderId: string,
): Promise<{ expired: boolean }> {
  const payable = await deps.store.findPayable(orderId);
  if (!payable) return { expired: false };
  if (!AWAITING.has(payable.paymentStatus)) return { expired: false };

  const now = deps.now?.() ?? new Date();
  if (!payable.expiresAt || now <= payable.expiresAt) return { expired: false };

  await deps.store.expirePayment({ orderId: payable.orderId, paymentId: payable.paymentId });
  return { expired: true };
}
