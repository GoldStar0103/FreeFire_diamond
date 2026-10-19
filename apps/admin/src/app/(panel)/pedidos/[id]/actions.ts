'use server';

import { revalidatePath } from 'next/cache';
import { applyReviewAction, approvePayment, type ReviewAction, type ReviewFailureCode } from '@levelup/engine';
import { GatewayError, type ChargeState } from '@levelup/payments';
import {
  DrizzlePaymentStore,
  DrizzleReviewStore,
  overrideOrderLp,
  reverseCompletedOrder,
} from '@levelup/db';
import { getDb } from '../../../../lib/db';
import { getMercadoPago } from '../../../../lib/mercadopago';
import { requireSession } from '../../../../lib/session';

export interface ReviewState {
  ok?: string;
  error?: string;
}

/**
 * Spanish for each refusal. The engine's own messages are for logs; the owner
 * needs to know what to do next.
 */
const EXPLAIN: Record<ReviewFailureCode, string> = {
  ORDER_NOT_FOUND: 'Ese pedido ya no existe.',
  WRONG_ORDER_STATUS: 'El pedido ya no está en revisión. Recarga la página.',
  ITEM_NOT_FOUND: 'Esa recarga no pertenece a este pedido.',
  ITEM_NOT_RESOLVABLE:
    'Esa recarga no se puede resolver a mano: ya tiene respuesta o está en proceso. Recarga la página.',
  NEEDS_CONFIRMATION:
    'Primero confirma en RecargasAmérica que esa recarga NO se cobró. Si se reenvía y sí se había cobrado, el cliente recibe doble.',
  UNRESOLVED_ITEMS:
    'Hay recargas sin resolver. Indica primero si llegaron o no; reanudar ahora podría entregar doble.',
  NOTHING_TO_RESUME: 'No queda nada por enviar en este pedido.',
  NOTE_REQUIRED: 'Escribe una nota: el motivo del reembolso, o cómo lo hiciste.',
  CONFLICT: 'El pedido cambió mientras lo revisabas. Recarga la página y vuelve a revisarlo.',
};

const SUCCESS: Record<ReviewAction['kind'], string> = {
  mark_item_delivered: 'Recarga marcada como entregada.',
  mark_item_not_delivered:
    'Recarga marcada como NO entregada. Se enviará de nuevo cuando presiones "Reanudar entregas".',
  resume: 'Listo: las recargas que faltan se están enviando.',
  flag_refund: 'Pedido marcado para reembolso. No se enviará nada más.',
  refund_done: 'Reembolso registrado. El pedido quedó cerrado.',
};

function readAction(formData: FormData): ReviewAction | null {
  const kind = String(formData.get('kind') ?? '');
  const itemId = String(formData.get('itemId') ?? '');
  const note = String(formData.get('note') ?? '');

  switch (kind) {
    case 'mark_item_delivered':
      return itemId ? { kind, itemId } : null;
    case 'mark_item_not_delivered':
      return itemId
        ? { kind, itemId, confirmedNotCharged: formData.get('confirmedNotCharged') === 'yes' }
        : null;
    case 'resume':
      return { kind };
    case 'flag_refund':
    case 'refund_done':
      return { kind, note };
    default:
      return null;
  }
}

export async function review(_prev: ReviewState, formData: FormData): Promise<ReviewState> {
  // A server action is a public endpoint; the layout's gate does not cover it.
  const session = await requireSession();

  const orderId = String(formData.get('orderId') ?? '');
  const action = readAction(formData);
  if (!orderId || !action) return { error: 'Acción no válida.' };

  const result = await applyReviewAction(
    { store: new DrizzleReviewStore(getDb()) },
    { orderId, adminUserId: session.adminUserId, action },
  );

  if (!result.ok) return { error: EXPLAIN[result.failure.code] };

  revalidatePath(`/pedidos/${orderId}`);
  revalidatePath('/pedidos');
  revalidatePath('/');

  return {
    ok:
      result.nextStatus === 'completed'
        ? `${result.orderNumber} quedó completado: todas las recargas entregadas.`
        : SUCCESS[action.kind],
  };
}

export interface ReleaseState {
  ok?: string;
  error?: string;
}

/**
 * Spanish for the `approvePayment` failures that can plausibly reach this
 * button. `PAYMENT_EXPIRED`/`AMOUNT_MISMATCH` cannot: `acceptMismatch: true`
 * below skips both checks on purpose, since the whole point is overriding
 * them once the client has independently confirmed the money is real.
 */
const EXPLAIN_RELEASE: Partial<Record<string, string>> = {
  ORDER_NOT_FOUND: 'Ese pedido ya no existe.',
  NOT_AWAITING_PAYMENT: 'El pago ya no está esperando confirmación — recarga la página para ver su estado real.',
};

/**
 * Force a SPEI/OXXO gateway payment through without the gateway's own
 * confirmation — client request, 2026-09-27: a real payment can be stuck
 * behind a gateway-side failure to report it, and making the customer wait
 * on support while insisting "it'll settle eventually" was costing more in
 * goodwill than the (now confirmed, not guessed) risk of releasing early.
 *
 * Deliberately the exact same `approvePayment` a webhook or a comprobante
 * approval calls — not a separate code path — so this gets the same
 * idempotency (double-tapping, or a webhook landing right after, is one
 * approval) and the same enqueue into fulfilment. `adminUserId` is set,
 * unlike a webhook's `null`, so the audit trail shows this was a human
 * override rather than an automatic settlement.
 */
export async function releasePayment(_prev: ReleaseState, formData: FormData): Promise<ReleaseState> {
  const session = await requireSession();

  const orderId = String(formData.get('orderId') ?? '');
  if (!orderId) return { error: 'Falta el pedido.' };

  const result = await approvePayment(
    { store: new DrizzlePaymentStore(getDb()) },
    { orderId, adminUserId: session.adminUserId, acceptMismatch: true },
  );

  if (!result.ok) {
    return { error: EXPLAIN_RELEASE[result.failure.code] ?? result.failure.message };
  }

  revalidatePath(`/pedidos/${orderId}`);
  revalidatePath('/pedidos');
  revalidatePath('/aprobaciones');
  revalidatePath('/');

  return {
    ok: result.alreadyApproved
      ? `${result.orderNumber} ya estaba confirmado.`
      : `${result.orderNumber} liberado — la recarga se está procesando.`,
  };
}

export interface LpOverrideState {
  ok?: string;
  warning?: string;
  error?: string;
}

/**
 * Manually set the Level Points an order awarded — the spec's authorised
 * override. The calculated figure is kept alongside the new one, and the
 * change is audited with the admin and their reason.
 */
export async function overrideLp(
  _prev: LpOverrideState,
  formData: FormData,
): Promise<LpOverrideState> {
  const session = await requireSession();

  const orderId = String(formData.get('orderId') ?? '');
  const raw = String(formData.get('lp') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  if (!orderId) return { error: 'Falta el pedido.' };

  const lp = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(lp)) {
    return { error: 'Escribe los LP como un número entero (0 o más).' };
  }
  if (reason.length < 3) {
    return { error: 'Escribe el motivo: queda en el registro de auditoría.' };
  }

  const result = await overrideOrderLp(getDb(), {
    orderId,
    adminUserId: session.adminUserId,
    newAwardedLp: lp,
    reason,
  });

  if (!result.ok) {
    const explain: Record<typeof result.reason, string> = {
      no_lp_transaction:
        'Este pedido no generó Level Points, así que no hay nada que ajustar.',
      reversed: 'Este pedido fue revertido — sus LP ya se quitaron.',
      invalid_lp: 'Ese valor de LP no es válido.',
    };
    return { error: explain[result.reason] };
  }

  revalidatePath(`/pedidos/${orderId}`);
  revalidatePath('/clientes');
  revalidatePath('/temporadas');

  const { plan } = result;
  const kept = plan.checkpointsKept;
  const parts: string[] = [`LP ajustados a ${plan.newAwardedLp}`];
  if (plan.checkpointsToCreate.length > 0) {
    parts.push(`${plan.checkpointsToCreate.length} checkpoint(s) alcanzado(s)`);
  }
  if (plan.checkpointEventIdsToReverse.length > 0) {
    parts.push(`${plan.checkpointEventIdsToReverse.length} retirado(s)`);
  }
  if (plan.unlockVault) parts.push('Bóveda abierta');
  if (plan.closeVault) parts.push('Bóveda cerrada');

  if (kept.length > 0) {
    const list = kept.map((c) => `${c.checkpointLp} LP`).join(', ');
    return {
      warning:
        `${parts.join(' · ')}. La recompensa de ${list} ya se había entregado, ` +
        `así que se queda — esos diamantes no se recuperan.`,
    };
  }

  return { ok: `${parts.join(' · ')}.` };
}

export interface ReverseState {
  ok?: string;
  warning?: string;
  error?: string;
}

/**
 * Reverse a COMPLETED order: the customer was charged back or refunded after
 * the diamonds had already gone out.
 *
 * Separate from the existing "Requiere reembolso" flow, which is for an order
 * that was never delivered and therefore never earned anything. This one has
 * to unwind the Level Pass progress the delivery created — see
 * `reverseCompletedOrder` for the policy and what it deliberately cannot undo.
 */
export async function reverseOrder(_prev: ReverseState, formData: FormData): Promise<ReverseState> {
  const session = await requireSession();

  const orderId = String(formData.get('orderId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!orderId) return { error: 'Falta el pedido.' };
  if (reason.length < 3) {
    return { error: 'Escribe el motivo: el cliente lo verá en su página de seguimiento.' };
  }

  const result = await reverseCompletedOrder(getDb(), {
    orderId,
    adminUserId: session.adminUserId,
    reason,
  });

  if (!result.ok) {
    return {
      error:
        result.reason === 'not_found'
          ? 'Ese pedido ya no existe.'
          : 'Ese pedido ya no está completado — quizá alguien más ya lo revirtió. Recarga la página.',
    };
  }

  revalidatePath(`/pedidos/${orderId}`);
  revalidatePath('/pedidos');
  revalidatePath('/contabilidad');
  revalidatePath('/temporadas');
  revalidatePath('/');

  const plan = result.plan;
  const kept = plan?.checkpointsKept ?? [];
  if (kept.length > 0) {
    // Not an error — the reversal did everything it could. But the client is
    // out this money and should hear it now, not discover it in the accounts.
    const list = kept.map((c) => `${c.checkpointLp} LP`).join(', ');
    return {
      warning:
        `Pedido revertido. No se pudo recuperar la recompensa de ${list}: ` +
        `esos diamantes ya se entregaron y su costo queda registrado.`,
    };
  }

  return {
    ok: plan
      ? `Pedido revertido — se quitaron ${plan.lpRemoved} LP y ${plan.rankingDiamondsRemoved} 💎 del ranking.`
      : 'Pedido revertido. No tenía progreso de Level Pass que deshacer.',
  };
}

export interface MpCheckState {
  status: 'idle' | 'ok' | 'not_found' | 'error';
  message?: string;
  snapshot?: {
    state: ChargeState;
    amountReceivedCents: number | null;
    paidAt: string | null;
    reference: string | null;
    voucherUrl: string | null;
  };
}

/**
 * Ask Mercado Pago directly what it has on file for this order — client
 * request, 2026-10-19: a customer disputes a payment ("I paid, where's my
 * order?") and the owner needs the gateway's own answer, not just our
 * recorded state, to tell a real provider-side miss from a scam attempt.
 *
 * Read-only: never touches `payments`, never calls `approvePayment`. If the
 * money really is there and unrecorded, that's still a job for "Liberar
 * recarga" (or the reconciliation cron) — this button only answers the
 * question, it doesn't act on it.
 *
 * Looked up by `orderNumber`, not the stored payment reference — see
 * `MercadoPagoGateway.getCharge`'s own comment: a Mercado Pago Preference is
 * closed the instant it's created, so the only thing ever searchable is the
 * order number it was tagged with (`external_reference`).
 */
export async function checkMercadoPagoPayment(_prev: MpCheckState, formData: FormData): Promise<MpCheckState> {
  await requireSession();

  const orderNumber = String(formData.get('orderNumber') ?? '');
  if (!orderNumber) return { status: 'error', message: 'Falta el pedido.' };

  const gateway = getMercadoPago();
  if (!gateway) return { status: 'error', message: 'Mercado Pago no está configurado en este servidor.' };

  let snapshot;
  try {
    snapshot = await gateway.getCharge(orderNumber);
  } catch (err) {
    return {
      status: 'error',
      message:
        err instanceof GatewayError
          ? `Mercado Pago no respondió: ${err.message}`
          : 'No se pudo contactar a Mercado Pago. Intenta de nuevo.',
    };
  }

  if (!snapshot) {
    return {
      status: 'not_found',
      message: 'Mercado Pago no tiene ningún pago registrado con este número de pedido.',
    };
  }

  return {
    status: 'ok',
    snapshot: {
      state: snapshot.state,
      amountReceivedCents: snapshot.amountReceivedCents,
      paidAt: snapshot.paidAt ? snapshot.paidAt.toISOString() : null,
      reference: snapshot.reference ?? null,
      voucherUrl: snapshot.voucherUrl ?? null,
    },
  };
}
