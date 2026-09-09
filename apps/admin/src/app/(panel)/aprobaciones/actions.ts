'use server';

import { revalidatePath } from 'next/cache';
import { approvePayment, rejectPayment } from '@levelup/engine';
import { DrizzlePaymentStore } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';

export interface ActionResult {
  ok?: string;
  error?: string;
}

/** Spanish messages for the failures the engine can return. */
function explain(code: string, message: string): string {
  switch (code) {
    case 'AMOUNT_MISMATCH':
      return `${message} Revisa el comprobante y aprueba con "forzar" si el monto es correcto.`;
    case 'PAYMENT_EXPIRED':
      return `${message} Puedes aprobarlo de todos modos con "forzar".`;
    case 'NOT_AWAITING_PAYMENT':
      return message;
    case 'ORDER_NOT_FOUND':
      return 'Ese pedido ya no existe.';
    default:
      return message;
  }
}

export async function approve(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  // Re-checked inside the action: a server action is a public endpoint, and the
  // layout's gate does not protect it.
  const session = await requireSession();

  const orderId = String(formData.get('orderId') ?? '');
  const force = formData.get('force') === 'true';
  const rawAmount = String(formData.get('amountReceived') ?? '').trim();

  if (!orderId) return { error: 'Falta el pedido.' };

  let amountReceivedCents: number | undefined;
  if (rawAmount !== '') {
    const pesos = Number(rawAmount);
    if (!Number.isFinite(pesos) || pesos < 0) return { error: 'El monto recibido no es válido.' };
    amountReceivedCents = Math.round(pesos * 100);
  }

  const result = await approvePayment(
    { store: new DrizzlePaymentStore(getDb()) },
    {
      orderId,
      adminUserId: session.adminUserId,
      acceptMismatch: force,
      ...(amountReceivedCents === undefined ? {} : { amountReceivedCents }),
    },
  );

  if (!result.ok) return { error: explain(result.failure.code, result.failure.message) };

  revalidatePath('/aprobaciones');
  revalidatePath('/pedidos');

  return {
    ok: result.alreadyApproved
      ? `${result.orderNumber} ya estaba aprobado.`
      : `${result.orderNumber} aprobado. La recarga se está procesando.`,
  };
}

export async function reject(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const orderId = String(formData.get('orderId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();

  if (!orderId) return { error: 'Falta el pedido.' };
  // The reason lands in the audit log and is what a later dispute is judged on.
  if (!reason) return { error: 'Escribe el motivo del rechazo.' };

  const result = await rejectPayment(
    { store: new DrizzlePaymentStore(getDb()) },
    { orderId, adminUserId: session.adminUserId, reason },
  );

  if (!result.ok) return { error: explain(result.failure.code, result.failure.message) };

  revalidatePath('/aprobaciones');
  revalidatePath('/pedidos');

  return { ok: `${result.orderNumber} rechazado y cancelado.` };
}
