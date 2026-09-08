'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { baseProducts, DrizzleOrderingStore, getStorefrontCombo } from '@levelup/db';
import { createOrder, type CreateOrderFailure } from '@levelup/engine';
import { ValidationUnsupportedError } from '@levelup/provider';
import { callerIp, db, provider, validationLimiter } from '../../../lib/server';
import { storeComprobante } from '../../../lib/storage';

// ── step 1: who is this player? ───────────────────────────────────────────────

export interface ValidateState {
  status: 'idle' | 'found' | 'not_found' | 'error';
  playerId?: string;
  nickname?: string;
  message?: string;
}

/**
 * Confirm the Free Fire ID before any money changes hands.
 *
 * This is the single most valuable step in the flow. Diamonds sent to a
 * mistyped ID land in a stranger's account and cannot be recovered — no
 * refund, no reversal. Showing the player their own in-game name is both the
 * error check and, for a first-time buyer who does not trust the site yet, the
 * strongest proof it is real.
 */
export async function validatePlayer(
  _prev: ValidateState,
  formData: FormData,
): Promise<ValidateState> {
  const playerId = String(formData.get('playerId') ?? '').trim();

  if (!/^\d{6,15}$/.test(playerId)) {
    return { status: 'error', message: 'El ID debe tener entre 6 y 15 números.' };
  }

  const decision = validationLimiter.check(await callerIp());
  if (!decision.allowed) {
    return {
      status: 'error',
      message: `Demasiados intentos. Espera ${Math.ceil(decision.retryAfterMs / 1000)} segundos.`,
    };
  }

  // Any recharge-type product validates the same account, so use the cheapest
  // one on the books — validation does not charge, but this keeps it obvious
  // that nothing expensive is being touched.
  const [validator] = await db
    .select({ providerProductId: baseProducts.providerProductId })
    .from(baseProducts)
    .where(eq(baseProducts.canValidate, true))
    .orderBy(baseProducts.diamondsBase)
    .limit(1);

  if (!validator) {
    return {
      status: 'error',
      message: 'No podemos verificar tu ID en este momento. Intenta más tarde.',
    };
  }

  try {
    const result = await provider.validatePlayer(validator.providerProductId, playerId);

    if (!result.found || !result.nickname) {
      return {
        status: 'not_found',
        playerId,
        message: 'No encontramos ese ID. Revísalo e intenta de nuevo.',
      };
    }

    return { status: 'found', playerId, nickname: result.nickname };
  } catch (err) {
    if (err instanceof ValidationUnsupportedError) {
      // Should not happen — we filtered on canValidate — but if the catalog
      // ever drifts, say so plainly rather than pretending the ID is wrong.
      console.error('[validate] product does not support validation', err);
      return { status: 'error', message: 'No podemos verificar tu ID en este momento.' };
    }
    console.error('[validate] provider call failed', err);
    return {
      status: 'error',
      message: 'No pudimos contactar al servidor de Free Fire. Intenta en un momento.',
    };
  }
}

// ── step 2: place the order ───────────────────────────────────────────────────

export interface CheckoutState {
  error?: string;
}

/** The product used for validation lookups. Validation never charges. */
async function validationProductId(): Promise<string | null> {
  const [row] = await db
    .select({ providerProductId: baseProducts.providerProductId })
    .from(baseProducts)
    .where(eq(baseProducts.canValidate, true))
    .orderBy(baseProducts.diamondsBase)
    .limit(1);
  return row?.providerProductId ?? null;
}

type ConfirmResult = { ok: true; nickname: string } | { ok: false; message: string };

async function confirmPlayer(playerId: string): Promise<ConfirmResult> {
  if (!/^\d{6,15}$/.test(playerId)) {
    return { ok: false, message: 'El ID de jugador no es válido.' };
  }

  const productId = await validationProductId();
  if (!productId) {
    return { ok: false, message: 'No podemos verificar tu ID en este momento.' };
  }

  try {
    const result = await provider.validatePlayer(productId, playerId);
    if (!result.found || !result.nickname) {
      return { ok: false, message: 'No encontramos ese ID de Free Fire. Revísalo por favor.' };
    }
    return { ok: true, nickname: result.nickname };
  } catch (err) {
    console.error('[checkout] player re-validation failed', err);
    // Refuse rather than proceed: an unverified ID is the one error in this
    // system that cannot be undone once diamonds are sent.
    return {
      ok: false,
      message: 'No pudimos verificar tu cuenta ahora mismo. Intenta en un momento.',
    };
  }
}

/** Spanish for each way order creation can refuse. */
function explain(failure: CreateOrderFailure): string {
  switch (failure.code) {
    case 'COMBO_NOT_FOUND':
    case 'COMBO_INACTIVE':
    case 'COMBO_EXPIRED':
      return 'Esta promoción ya no está disponible.';
    case 'PLAYER_LIMIT_REACHED':
      return 'Esta oferta es solo para clientes nuevos, y este ID ya la usó.';
    case 'INVALID_PLAYER_ID':
      return 'El ID de jugador no es válido.';
    case 'SERVER_ID_REQUIRED':
      return 'Falta seleccionar tu servidor.';
    default:
      // Recipe and catalog problems are our fault, not the customer's — never
      // show them the internals.
      console.error('[checkout] order creation failed', failure);
      return 'No pudimos crear tu pedido. Escríbenos por WhatsApp y lo resolvemos.';
  }
}

export async function placeOrder(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const comboKey = String(formData.get('comboKey') ?? '');
  const playerId = String(formData.get('playerId') ?? '').trim();
  const whatsapp = String(formData.get('whatsapp') ?? '').trim() || null;
  const comprobante = formData.get('comprobante');

  const combo = await getStorefrontCombo(db, comboKey);
  if (!combo) return { error: 'Esta promoción ya no está disponible.' };

  if (!(comprobante instanceof File) || comprobante.size === 0) {
    return { error: 'Sube la foto de tu comprobante de pago.' };
  }

  /**
   * Re-confirm the player server-side.
   *
   * A server action is a public endpoint: the two-step form is a UX gate, not
   * a security one, and a crafted POST could skip it. Two things depend on this
   * running here — that we never accept an order for an ID nobody checked, and
   * that the nickname stored as evidence of who we confirmed comes from the
   * provider rather than from the form. One extra call, and it does not charge.
   */
  const confirmed = await confirmPlayer(playerId);
  if (!confirmed.ok) return { error: confirmed.message };

  const created = await createOrder(
    { store: new DrizzleOrderingStore(db) },
    {
      comboKey,
      playerId,
      playerNickname: confirmed.nickname,
      contactWhatsapp: whatsapp,
      paymentMethod: 'transfer_manual',
      source: 'storefront',
    },
  );

  if (!created.ok) return { error: explain(created.failure) };

  // Stored after the order exists so the file is keyed to a real order number,
  // and an upload that fails validation cannot leave an orphan on disk.
  const stored = await storeComprobante(
    created.order.orderNumber,
    new Uint8Array(await comprobante.arrayBuffer()),
  );

  if (!stored.ok) {
    // The order stands — it is simply waiting for a readable comprobante, and
    // the customer can send one over WhatsApp using the order number.
    return { error: stored.rejection.message };
  }

  await attachComprobante(created.order.id, stored.key);

  redirect(`/pedido/${created.order.orderNumber}?id=${encodeURIComponent(playerId)}`);
}

async function attachComprobante(orderId: string, key: string): Promise<void> {
  const { payments } = await import('@levelup/db');
  await db
    .update(payments)
    .set({ comprobanteAssetUrl: key, status: 'under_review' })
    .where(eq(payments.orderId, orderId));
}
