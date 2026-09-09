'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { baseProducts, DrizzleOrderingStore, DrizzlePaymentStore } from '@levelup/db';
import { approvePayment, createOrder, type CreateOrderFailure } from '@levelup/engine';
import { getDb } from '../../../../lib/db';
import { provider } from '../../../../lib/provider';
import { requireSession } from '../../../../lib/session';

export interface LookupState {
  status: 'idle' | 'found' | 'not_found' | 'error';
  playerId?: string;
  nickname?: string;
  message?: string;
}

export interface CreateState {
  error?: string;
}

/** Any recharge-type product validates the same account; validation is free. */
async function validationProductId(): Promise<string | null> {
  const [row] = await getDb()
    .select({ providerProductId: baseProducts.providerProductId })
    .from(baseProducts)
    .where(eq(baseProducts.canValidate, true))
    .orderBy(baseProducts.diamondsBase)
    .limit(1);
  return row?.providerProductId ?? null;
}

export async function lookupPlayer(
  _prev: LookupState,
  formData: FormData,
): Promise<LookupState> {
  await requireSession();

  const playerId = String(formData.get('playerId') ?? '').trim();
  if (!/^\d{6,15}$/.test(playerId)) {
    return { status: 'error', message: 'El ID debe tener entre 6 y 15 números.' };
  }

  const productId = await validationProductId();
  if (!productId) {
    return { status: 'error', message: 'Corre la sincronización del catálogo primero.' };
  }

  try {
    const result = await provider.validatePlayer(productId, playerId);
    return result.found && result.nickname
      ? { status: 'found', playerId, nickname: result.nickname }
      : { status: 'not_found', playerId, message: 'No existe esa cuenta de Free Fire.' };
  } catch (err) {
    console.error('[admin] player lookup failed', err);
    return { status: 'error', playerId, message: 'No se pudo consultar al proveedor.' };
  }
}

function explain(failure: CreateOrderFailure): string {
  switch (failure.code) {
    case 'PLAYER_LIMIT_REACHED':
      return `${failure.message} Si aun así quieres dárselo, usa otro combo.`;
    case 'RECIPE_UNDER_DELIVERS':
      return `${failure.message} Corrige el combo antes de venderlo.`;
    case 'CATALOG_NOT_SYNCED':
    case 'PRODUCT_UNAVAILABLE':
      return `${failure.message} Corre la sincronización del catálogo.`;
    default:
      return failure.message;
  }
}

/**
 * Record a sale made outside the storefront.
 *
 * This is how the client keeps taking orders over WhatsApp while getting the
 * automated fulfilment: they enter what the customer bought, mark the payment
 * received, and the worker does the rest.
 *
 * The player ID is confirmed against the game here rather than trusted from the
 * form. A server action is a public endpoint, and diamonds sent to a mistyped
 * ID are the one mistake in this system that cannot be undone.
 */
export async function createManualOrder(
  _prev: CreateState,
  formData: FormData,
): Promise<CreateState> {
  const session = await requireSession();

  const comboKey = String(formData.get('comboKey') ?? '');
  const playerId = String(formData.get('playerId') ?? '').trim();
  const whatsapp = String(formData.get('whatsapp') ?? '').trim() || null;
  const reference = String(formData.get('reference') ?? '').trim() || null;
  const markPaid = formData.get('markPaid') === 'true';

  if (!comboKey) return { error: 'Elige un combo.' };

  const productId = await validationProductId();
  if (!productId) return { error: 'Corre la sincronización del catálogo primero.' };

  let nickname: string;
  try {
    const check = await provider.validatePlayer(productId, playerId);
    if (!check.found || !check.nickname) {
      return { error: 'No existe esa cuenta de Free Fire. Revisa el ID.' };
    }
    nickname = check.nickname;
  } catch (err) {
    console.error('[admin] validation failed during manual order', err);
    // Refuse rather than record an unverified ID. If the provider is
    // unreachable the order could not be fulfilled anyway.
    return { error: 'No se pudo verificar el ID con el proveedor. Intenta en un momento.' };
  }

  const created = await createOrder(
    { store: new DrizzleOrderingStore(getDb()) },
    {
      comboKey,
      playerId,
      playerNickname: nickname,
      contactWhatsapp: whatsapp,
      paymentMethod: 'transfer_manual',
      // Admin source: a combo retired mid-month can still be honoured for a
      // customer who already paid for it.
      source: 'admin',
    },
  );

  if (!created.ok) return { error: explain(created.failure) };

  if (markPaid) {
    // Through approvePayment, not a direct write — so a manual sale gets the
    // same audit entry, the same idempotency and the same enqueue as every
    // other payment.
    const approval = await approvePayment(
      { store: new DrizzlePaymentStore(getDb()) },
      { orderId: created.order.id, adminUserId: session.adminUserId, reference },
    );

    if (!approval.ok) {
      // The order exists and is recoverable from the approvals queue.
      return {
        error: `Se creó ${created.order.orderNumber} pero no se pudo marcar como pagado: ${approval.failure.message}`,
      };
    }
  }

  revalidatePath('/pedidos');
  revalidatePath('/aprobaciones');
  redirect(`/pedidos/${created.order.id}`);
}
