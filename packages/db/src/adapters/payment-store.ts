/**
 * Drizzle implementation of the engine's `PaymentStore` port.
 *
 * `confirmPayment` is the single most consequential write in the system: it
 * flips the payment to paid and the order to `payment_confirmed`, and because
 * the orders table *is* the work queue, that second write is the enqueue.
 *
 * Both go in one transaction. A payment marked paid without the order moving
 * would leave a customer who paid and receives nothing, with no queue entry to
 * find them by.
 */

import { and, desc, eq, ne } from 'drizzle-orm';
import type { PayableOrder, PaymentStore, PaymentState } from '@levelup/engine';
import type { Database } from '../index.js';
import { auditLog, orders, payments } from '../schema.js';

export class DrizzlePaymentStore implements PaymentStore {
  constructor(private readonly db: Database) {}

  async findPayable(orderId: string): Promise<PayableOrder | null> {
    const [row] = await this.db
      .select({
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        orderStatus: orders.status,
        paymentId: payments.id,
        paymentStatus: payments.status,
        method: payments.method,
        amountExpectedCents: payments.amountExpectedCents,
        expiresAt: payments.expiresAt,
      })
      .from(orders)
      .innerJoin(payments, eq(payments.orderId, orders.id))
      .where(eq(orders.id, orderId))
      // An order can accumulate payment attempts (an expired OXXO voucher, then
      // a transfer). The most recent one is the live attempt.
      .orderBy(desc(payments.createdAt))
      .limit(1);

    if (!row) return null;

    return {
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      orderStatus: row.orderStatus,
      paymentId: row.paymentId,
      paymentStatus: row.paymentStatus as PaymentState,
      method: row.method,
      amountExpectedCents: row.amountExpectedCents,
      expiresAt: row.expiresAt,
    };
  }

  async confirmPayment(input: {
    orderId: string;
    paymentId: string;
    amountReceivedCents: number;
    adminUserId: string | null;
    reference: string | null;
    acceptedMismatch: boolean;
  }): Promise<void> {
    const paidAt = new Date();

    await this.db.transaction(async (tx) => {
      // Guarded on the current status so two approvals racing cannot both
      // enqueue. The second matches zero rows and aborts the transaction.
      const updated = await tx
        .update(payments)
        .set({
          status: 'paid',
          amountReceivedCents: input.amountReceivedCents,
          paidAt,
          reviewedByAdminId: input.adminUserId,
          ...(input.reference === null ? {} : { reference: input.reference }),
        })
        .where(and(eq(payments.id, input.paymentId), ne(payments.status, 'paid')))
        .returning({ id: payments.id });

      if (updated.length === 0) {
        throw new Error(
          `Payment ${input.paymentId} was already settled by another request — not enqueuing twice.`,
        );
      }

      await tx
        .update(orders)
        .set({ status: 'payment_confirmed', paidAt, updatedAt: paidAt })
        .where(eq(orders.id, input.orderId));

      await tx.insert(auditLog).values({
        adminUserId: input.adminUserId,
        action: input.acceptedMismatch ? 'payment.approved_with_mismatch' : 'payment.approved',
        entityType: 'order',
        entityId: input.orderId,
        detail: {
          paymentId: input.paymentId,
          amountReceivedCents: input.amountReceivedCents,
          reference: input.reference,
        },
      });
    });
  }

  async flagMismatch(input: {
    orderId: string;
    paymentId: string;
    amountReceivedCents: number;
    adminUserId: string | null;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({ status: 'amount_mismatch', amountReceivedCents: input.amountReceivedCents })
        .where(eq(payments.id, input.paymentId));

      // The order does NOT move to payment_confirmed — nothing ships until a
      // human decides what the difference means.
      await tx.insert(auditLog).values({
        adminUserId: input.adminUserId,
        action: 'payment.amount_mismatch',
        entityType: 'order',
        entityId: input.orderId,
        detail: { paymentId: input.paymentId, amountReceivedCents: input.amountReceivedCents },
      });
    });
  }

  async rejectPayment(input: {
    orderId: string;
    paymentId: string;
    adminUserId: string | null;
    reason: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(payments).set({ status: 'failed' }).where(eq(payments.id, input.paymentId));

      await tx
        .update(orders)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(orders.id, input.orderId));

      await tx.insert(auditLog).values({
        adminUserId: input.adminUserId,
        action: 'payment.rejected',
        entityType: 'order',
        entityId: input.orderId,
        detail: { paymentId: input.paymentId, reason: input.reason },
      });
    });
  }

  async expirePayment(input: { orderId: string; paymentId: string }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(payments).set({ status: 'expired' }).where(eq(payments.id, input.paymentId));

      await tx
        .update(orders)
        .set({ status: 'payment_expired', updatedAt: new Date() })
        .where(eq(orders.id, input.orderId));
    });
  }
}
