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
 * Card payments through Stripe replace the human with a webhook calling the
 * same function — see `settleGatewayCharge`.
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
  | { code: 'CARD_PAYMENT_NOT_REJECTABLE'; message: string }
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

  // There is no comprobante to reject on a Stripe-routed payment — card,
  // OXXO, or SPEI — Stripe's webhook is what settles it, on its own, with no
  // human step. One sitting here is simply a customer still on Stripe's page,
  // or one who paid an OXXO/SPEI reference and is waiting on Stripe to hear
  // it back (which can take hours), or one who abandoned checkout (which the
  // expiry sweep already handles once the session's grace period actually
  // passes). Rejecting it by hand can beat that webhook to the punch: a real
  // incident (2026-09-18, order LU-260918-0RTQ) had a card order rejected as
  // "sin comprobante" 22 seconds after checkout started — the customer's $750
  // MXN charge succeeded in Stripe six minutes later, but by then the order
  // was already cancelled and the approval was refused. This used to only
  // check for 'card' specifically, back when every Stripe order was recorded
  // that way regardless of which method actually settled it; once OXXO/SPEI
  // checkouts started recording their real method, this stopped catching
  // them too.
  if (payable.method === 'card' || payable.method === 'oxxo' || payable.method === 'spei') {
    return {
      ok: false,
      failure: {
        code: 'CARD_PAYMENT_NOT_REJECTABLE',
        message:
          `${payable.orderNumber} is a ${payable.method} payment through Stripe — it confirms ` +
          `itself automatically once Stripe reports it. There is nothing to reject; wait for it ` +
          `to settle or expire.`,
      },
    };
  }

  try {
    await deps.store.rejectPayment({
      orderId: payable.orderId,
      paymentId: payable.paymentId,
      adminUserId: input.adminUserId ?? null,
      reason: input.reason,
    });
  } catch {
    // The store guards this write against the exact race the check above
    // cannot: the payment was confirmed (a webhook, another admin) in the gap
    // between that check and this write landing. Re-read rather than assume,
    // since it may since have moved on again (e.g. straight to needs_review).
    const now = await deps.store.findPayable(input.orderId);
    return {
      ok: false,
      failure: {
        code: 'NOT_AWAITING_PAYMENT',
        message: `${payable.orderNumber} was confirmed as paid just now — use a refund, not a rejection.`,
        paymentStatus: now?.paymentStatus ?? 'paid',
      },
    };
  }

  return {
    ok: true,
    orderId: payable.orderId,
    orderNumber: payable.orderNumber,
    alreadyApproved: false,
  };
}

// ── gateway settlement ────────────────────────────────────────────────────────

/** What a card gateway reports about a charge, in gateway-neutral terms. */
export type GatewayChargeState = 'pending' | 'paid' | 'expired' | 'failed' | 'refunded';

export interface GatewayReport {
  orderId: string;
  state: GatewayChargeState;
  /** What the gateway says arrived. Required for `paid`. */
  amountReceivedCents: number | null;
  /** The gateway's id for the money movement, kept as the payment reference. */
  reference: string | null;
}

export type GatewaySettlement =
  | { action: 'approved'; orderNumber: string }
  | { action: 'already_approved'; orderNumber: string }
  | { action: 'expired'; orderNumber: string }
  | { action: 'ignored'; reason: string }
  /**
   * Money arrived and the order could not be approved — an amount mismatch, a
   * voucher paid after the window, an order already cancelled. Somebody paid
   * and nothing will ship until a human looks. The caller must alert.
   */
  | { action: 'refused'; failure: PaymentFailure };

/**
 * Apply a gateway's report to an order.
 *
 * Deliberately thin. `paid` goes through `approvePayment` — the same function
 * an admin's tap calls — so a card payment gets exactly the same amount check,
 * the same idempotency and the same enqueue as a comprobante. A webhook
 * redelivered five times lands as one approval and four `already_approved`s.
 *
 * The gateway amount is always passed through, never assumed. Stripe will not
 * charge a different amount than the session asked for, but the session could
 * have been created by something other than this code, and assuming would
 * make that invisible.
 */
export async function settleGatewayCharge(
  deps: PaymentDeps,
  report: GatewayReport,
): Promise<GatewaySettlement> {
  if (report.state === 'paid') {
    if (report.amountReceivedCents === null) {
      // A paid report with no amount is not something to approve on trust.
      return {
        action: 'refused',
        failure: {
          code: 'AMOUNT_MISMATCH',
          message: 'Gateway reported paid without an amount.',
          expectedCents: 0,
          receivedCents: 0,
        },
      };
    }

    const result = await approvePayment(deps, {
      orderId: report.orderId,
      amountReceivedCents: report.amountReceivedCents,
      adminUserId: null,
      reference: report.reference,
    });

    if (!result.ok) return { action: 'refused', failure: result.failure };
    return result.alreadyApproved
      ? { action: 'already_approved', orderNumber: result.orderNumber }
      : { action: 'approved', orderNumber: result.orderNumber };
  }

  if (report.state === 'expired' || report.state === 'failed') {
    const payable = await deps.store.findPayable(report.orderId);
    if (!payable) return { action: 'ignored', reason: 'order not found' };

    // Same line `expireOverduePayments` holds: only a payment nobody has acted
    // on. A comprobante under review, or an approval that raced this event,
    // must survive it.
    if (payable.paymentStatus !== 'pending' || payable.orderStatus !== 'pending_payment') {
      return { action: 'ignored', reason: `payment is ${payable.paymentStatus}` };
    }

    await deps.store.expirePayment({ orderId: payable.orderId, paymentId: payable.paymentId });
    return { action: 'expired', orderNumber: payable.orderNumber };
  }

  if (report.state === 'refunded') {
    // Diamonds cannot be recalled, so a refund issued from the gateway
    // dashboard is a decision a person already made. Nothing to automate.
    return { action: 'ignored', reason: 'refunds are handled by hand' };
  }

  return { action: 'ignored', reason: 'still pending' };
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

  try {
    await deps.store.expirePayment({ orderId: payable.orderId, paymentId: payable.paymentId });
  } catch {
    // The store guards this write against the same race the header comment
    // already calls out: paid while this call was mid-flight. `expired: false`
    // is exactly the right answer here — it was not expired, correctly.
    return { expired: false };
  }
  return { expired: true };
}
