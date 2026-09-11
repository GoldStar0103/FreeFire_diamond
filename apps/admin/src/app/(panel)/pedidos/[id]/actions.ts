'use server';

import { revalidatePath } from 'next/cache';
import { applyReviewAction, type ReviewAction, type ReviewFailureCode } from '@levelup/engine';
import { DrizzleReviewStore } from '@levelup/db';
import { getDb } from '../../../../lib/db';
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
