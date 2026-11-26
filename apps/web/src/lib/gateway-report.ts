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

import {
  attachGatewayCharge,
  DrizzlePaymentStore,
  extendPaymentDeadline,
  findGatewayPayment,
  findPaymentByOrderNumber,
} from '@levelup/db';
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
   * The gateway's own copy of the order number (e.g. Mercado Pago's
   * `external_reference`), when the gateway carries one. Used only as a
   * fallback when this charge can't be found by `gatewayChargeId` — see the
   * comment where it's used below. `undefined`/`null` for a gateway that
   * doesn't report one (Stripe's session carries the order number too, but
   * nothing here depends on it doing so).
   */
  orderNumber?: string | null;
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
  let payment = await findGatewayPayment(db, gateway, report.gatewayChargeId);

  // Self-heal applies whenever there's something worth reconnecting: real
  // money (`paid`), or a `pending` report that just issued a voucher/CLABE —
  // the one with a real side effect below (extending the deadline) that must
  // not silently get skipped. A bare "still processing" ping with nothing to
  // do once found isn't worth the extra lookup.
  const selfHealWorthy = report.state === 'paid' || (report.state === 'pending' && report.voucherIssued);

  if (!payment && !selfHealWorthy) {
    return { paymentId: null, orderNumber: null, settlement: null };
  }

  if (!payment) {
    // Our own write linking a freshly created charge to its order
    // (`attachGatewayCharge`) can fail or get overwritten without the charge
    // itself failing — confirmed in production 2026-11-26: two near-
    // simultaneous payment attempts on the same resumable order (e.g. a
    // customer who tried both SPEI and card) each created a real charge at
    // Mercado Pago, but only the last `attachGatewayCharge` write wins, so
    // the other one's charge arrives with no local link at all. Originally
    // this self-heal only ran once that charge was reported `paid` — but a
    // `pending` SPEI/OXXO report for the same orphaned charge arrives first,
    // and used to be dropped silently right here, which meant its deadline
    // extension below never ran either. If the sweep then expired the order
    // before the eventual `paid` report arrived, THIS block's own
    // `byOrder.paymentStatus === 'pending'` check below would already be
    // false by the time it mattered, so the money landed as "duplicado"
    // instead of self-healing — confirmed 2026-11-26 as the real mechanism
    // behind Jose's "some SPEI payments don't link to the correct order"
    // report. Running this on the `pending` report too closes that gap.
    //
    // Before treating this as truly unaccounted-for, check whether the order
    // it actually belongs to (Mercado Pago's own `external_reference`, which
    // this app always sets to the order number and which that race never
    // touches) still has a payment waiting.
    const byOrder = report.orderNumber ? await findPaymentByOrderNumber(db, report.orderNumber) : null;

    if (byOrder && byOrder.paymentStatus === 'pending') {
      const attached = await attachGatewayCharge(db, {
        orderId: byOrder.orderId,
        gateway,
        gatewayChargeId: report.gatewayChargeId,
        expiresAt: null,
      });
      if (attached) {
        payment = await findGatewayPayment(db, gateway, report.gatewayChargeId);
      }
    }

    if (!payment) {
      // Only alert for a `paid` report — the one case that is unambiguously
      // somebody's real money sitting unaccounted-for. A `pending` voucher
      // that still can't find a home isn't money yet (and the admin panel's
      // own manual relink tool, see check-mercadopago-button.tsx, now covers
      // the case where a customer complains before the eventual `paid`
      // report — if it ever arrives — would otherwise retry this same path);
      // alerting on every such ping would just be noise ahead of the one
      // alert that actually matters.
      if (report.state === 'paid') {
        if (byOrder) {
          // The order exists and its payment is already settled by a
          // *different* charge — a second, genuinely separate charge for the
          // same order also got paid. Real money, already-fulfilled order: a
          // human needs to refund the extra charge, not fulfil anything
          // twice, so this never goes through `settleGatewayCharge`.
          await notifyOps('critical', 'Pago DUPLICADO recibido — el pedido ya fue aprobado con otro cargo', {
            gateway,
            pedido: byOrder.orderNumber,
            cargoDuplicado: report.gatewayChargeId,
            cargoYaAprobado: byOrder.gatewayChargeId,
            amountMxn: ((report.amountReceivedCents ?? 0) / 100).toFixed(2),
            reference: report.reference,
          });
        } else {
          // Money with no order at all, even by order number. Rare — but it
          // is someone's real money. No payment row means no known method
          // either, so this stays method-neutral rather than guessing.
          await notifyOps('critical', 'Pago recibido sin pedido asociado', {
            gateway,
            charge: report.gatewayChargeId,
            amountMxn: ((report.amountReceivedCents ?? 0) / 100).toFixed(2),
            reference: report.reference,
          });
        }
      }
      return { paymentId: null, orderNumber: null, settlement: null };
    }
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
