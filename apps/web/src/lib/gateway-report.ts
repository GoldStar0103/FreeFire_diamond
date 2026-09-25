/**
 * What a card/OXXO/SPEI gateway says about a charge, applied to its order.
 *
 * Shared between stripe.ts and mercadopago.ts on purpose — both gateways
 * report the exact same shape of fact ("this charge is now in state X, for
 * this much money") and this system's own rule already lives at the engine
 * layer: a gateway webhook and a human approving a comprobante go through the
 * identical `settleGatewayCharge`/`approvePayment` path, with the same
 * amount checks and the same idempotency. Splitting this per gateway would
 * just be two copies of the same five steps drifting apart over time.
 */

import { DrizzlePaymentStore, extendPaymentDeadline, findGatewayPayment } from '@levelup/db';
import {
  settleGatewayCharge,
  type GatewayChargeState,
  type GatewaySettlement,
} from '@levelup/engine';
import { getDb } from './server';
import { notifyOps } from './ops';
import { notifyGatewaySale } from './telegram';
import { mxn } from './format';

export interface GatewayReport {
  gatewayChargeId: string;
  state: GatewayChargeState;
  amountReceivedCents: number | null;
  reference: string | null;
  /**
   * An OXXO voucher or SPEI/bank-transfer reference was issued: the money is
   * hours-to-days away, not seconds. Same flag regardless of which method or
   * gateway fired it — the report itself doesn't say which one, and every
   * async method gets the same deadline treatment.
   */
  voucherIssued: boolean;
}

export interface AppliedReport {
  paymentId: string | null;
  orderNumber: string | null;
  settlement: GatewaySettlement | null;
}

/**
 * The order is found by the charge id we stored when creating it — never by
 * metadata/external_reference on the event. That value is signed (Stripe) or
 * fetched with our own access token (Mercado Pago) and so not forgeable
 * either way, but the charge id is the link this system itself recorded at
 * creation time, and it is the one that cannot point at the wrong order.
 *
 * `pendingGraceDays` is the caller's own: Stripe's OXXO/SPEI grace and
 * Mercado Pago's OXXO grace are configured independently (different env
 * vars, potentially different values), so this takes the number rather than
 * asking a specific gateway singleton for it.
 */
export async function applyGatewayReport(
  gateway: string,
  report: GatewayReport,
  pendingGraceDays: number,
): Promise<AppliedReport> {
  const db = getDb();
  const payment = await findGatewayPayment(db, gateway, report.gatewayChargeId);

  if (!payment) {
    if (report.state === 'paid') {
      // Money with no order. Rare — it means the charge was created and our
      // write linking it failed — but it is someone's real money. No payment
      // row means no known method either, so this stays method-neutral
      // rather than guessing.
      await notifyOps('critical', 'Pago recibido sin pedido asociado', {
        gateway,
        charge: report.gatewayChargeId,
        amountMxn: ((report.amountReceivedCents ?? 0) / 100).toFixed(2),
        reference: report.reference,
      });
    }
    return { paymentId: null, orderNumber: null, settlement: null };
  }

  if (report.state === 'pending' && report.voucherIssued) {
    // The checkout session/preference itself is short-lived; an OXXO voucher
    // or a SPEI transfer is payable for much longer. Move the deadline so the
    // sweep does not retire the order while the customer is still on their
    // way to pay.
    await extendPaymentDeadline(
      db,
      payment.paymentId,
      new Date(Date.now() + (pendingGraceDays + 1) * 86_400_000),
    );
  }

  const settlement = await settleGatewayCharge(
    { store: new DrizzlePaymentStore(db) },
    {
      orderId: payment.orderId,
      state: report.state,
      amountReceivedCents: report.amountReceivedCents,
      reference: report.reference,
    },
  );

  if (settlement.action === 'refused') {
    await notifyOps('critical', `Pago (${payment.method}) recibido pero NO aprobado — revisar a mano`, {
      gateway,
      order: payment.orderNumber,
      code: settlement.failure.code,
      detail: settlement.failure.message,
      reference: report.reference,
    });
  }

  // Only on the genuine first transition, never on 'already_approved' — the
  // webhook and the order-page fallback can both reach here for the same
  // event, and `settleGatewayCharge`'s own compare-and-set is what
  // guarantees only one of them sees 'approved'.
  if (settlement.action === 'approved') {
    await notifyGatewaySale({
      orderNumber: payment.orderNumber,
      comboName: payment.comboName,
      price: mxn(payment.priceMxnCents),
      method: payment.method,
    });
  }

  return { paymentId: payment.paymentId, orderNumber: payment.orderNumber, settlement };
}
