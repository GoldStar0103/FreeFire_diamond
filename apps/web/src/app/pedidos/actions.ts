'use server';

import { redirect } from 'next/navigation';
import { findCustomerOrder } from '@levelup/db';
import { callerIp, getDb, lookupLimiter } from '../../lib/server';

export interface LookupState {
  error?: string;
}

/**
 * Find an order from the number and the Free Fire ID.
 *
 * Rate limited because this is an oracle: the pairing makes guessing
 * impractical, but an unlimited endpoint still lets someone grind order
 * numbers against a known player ID. The same generic message is returned
 * whether the order is missing or the ID does not match, so a failed lookup
 * never confirms that an order number exists.
 */
export async function lookupOrder(
  _prev: LookupState,
  formData: FormData,
): Promise<LookupState> {
  const orderNumber = String(formData.get('orderNumber') ?? '').trim();
  const playerId = String(formData.get('playerId') ?? '').trim();

  if (!orderNumber || !playerId) {
    return { error: 'Escribe tu número de pedido y tu ID de Free Fire.' };
  }

  const decision = lookupLimiter.check(await callerIp());
  if (!decision.allowed) {
    return {
      error: `Demasiados intentos. Espera ${Math.ceil(decision.retryAfterMs / 1000)} segundos.`,
    };
  }

  const order = await findCustomerOrder(getDb(), orderNumber, playerId);
  if (!order) {
    return {
      error: 'No encontramos ese pedido. Revisa el número y tu ID de Free Fire.',
    };
  }

  redirect(`/pedido/${order.orderNumber}?id=${encodeURIComponent(order.playerId)}`);
}
