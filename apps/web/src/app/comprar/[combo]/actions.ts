'use server';

import { and, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import {
  attachGatewayCharge,
  baseProducts,
  DrizzleOrderingStore,
  DrizzlePaymentStore,
  getPaymentDetails,
  getStorefrontCombo,
} from '@levelup/db';
import { createOrder, rejectPayment, type CreateOrderFailure } from '@levelup/engine';
import { validateUpload } from '@levelup/shared';
import { ValidationUnsupportedError } from '@levelup/provider';
import { diamonds, mxn } from '../../../lib/format';
import { callerIp, getDb, getProvider, validationLimiter } from '../../../lib/server';
import { siteUrl } from '../../../lib/site';
import { storeComprobante } from '../../../lib/storage';
import { getStripe, SESSION_GRACE_MS, STRIPE } from '../../../lib/stripe';
import { notifyNewOrder } from '../../../lib/telegram';
import { trackingContext } from '../../../lib/tracking';

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

  const validator = await validationProductId();

  if (!validator) {
    return {
      status: 'error',
      message: 'No podemos verificar tu ID en este momento. Intenta más tarde.',
    };
  }

  try {
    const result = await getProvider().validatePlayer(validator, playerId);

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
  /**
   * Only set by the Stripe-backed actions. The client opens this in a new
   * tab (so the customer keeps the order-tracking page in the original one —
   * Stripe's own hosted confirmation for OXXO/SPEI does not redirect back on
   * its own) instead of navigating the whole page away like `placeOrder` does.
   */
  checkoutUrl?: string;
  /** Where the client should send the original tab once `checkoutUrl` opens. */
  orderPageUrl?: string;
}

/**
 * The product used for validation lookups. Validation never charges.
 *
 * Any recharge-type product validates the same account, so the cheapest one
 * on the books — nothing expensive is being touched. Active only: when the
 * provider replaces its product ids, the retired rows stay in the table (and
 * the 100 💎 one is still the cheapest), and validating against a dead id would
 * fail every customer at step one.
 */
async function validationProductId(): Promise<string | null> {
  const [row] = await getDb()
    .select({ providerProductId: baseProducts.providerProductId })
    .from(baseProducts)
    .where(and(eq(baseProducts.canValidate, true), eq(baseProducts.active, true)))
    .orderBy(baseProducts.diamondsBase)
    .limit(1);
  return row?.providerProductId ?? null;
}

type ConfirmResult = { ok: true; nickname: string } | { ok: false; message: string };

/**
 * `placeOrder` and `payWithCard` are public POST endpoints in their own
 * right — `payWithCard` reaches this with nothing but a combo key and a
 * player ID, no comprobante, no prior step. Without its own check here,
 * `validatePlayer`'s rate limit only ever throttled the UI's own step 1;
 * this call hits the exact same provider lookup and was reachable at any
 * rate directly through step 2, silently doubling as the free ID-enumeration
 * oracle `validationLimiter`'s own doc comment says it exists to prevent.
 */
async function confirmPlayer(playerId: string): Promise<ConfirmResult> {
  if (!/^\d{6,15}$/.test(playerId)) {
    return { ok: false, message: 'El ID de jugador no es válido.' };
  }

  const decision = validationLimiter.check(await callerIp());
  if (!decision.allowed) {
    return {
      ok: false,
      message: `Demasiados intentos. Espera ${Math.ceil(decision.retryAfterMs / 1000)} segundos.`,
    };
  }

  const productId = await validationProductId();
  if (!productId) {
    return { ok: false, message: 'No podemos verificar tu ID en este momento.' };
  }

  try {
    const result = await getProvider().validatePlayer(productId, playerId);
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

  const combo = await getStorefrontCombo(getDb(), comboKey);
  if (!combo) return { error: 'Esta promoción ya no está disponible.' };

  // Re-checked server-side for the same reason the player ID is: the form is a
  // UX gate and a crafted POST can skip it. An order created while no account
  // is configured is a customer who believes they have bought something and a
  // payment that can never arrive.
  if (!(await getPaymentDetails(getDb()))) {
    return {
      error: 'Estamos actualizando nuestros datos de pago. Escríbenos por WhatsApp para completar tu compra.',
    };
  }

  if (!(comprobante instanceof File) || comprobante.size === 0) {
    return { error: 'Sube la foto de tu comprobante de pago.' };
  }

  // The form marks this required too — re-checked here for the same reason as
  // the comprobante above: a crafted POST can skip a client-side `required`.
  if (!whatsapp) {
    return { error: 'Ingresa tu número de WhatsApp para poder contactarte si hace falta.' };
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

  /**
   * Check the file BEFORE the order exists.
   *
   * This used to run after `createOrder`, so a rejected comprobante — an
   * unsupported format, or a photo over 8MB — left a real order sitting in
   * `pending_payment`. The customer then retried with a better photo and, for
   * the Mega Oferta, was refused: the one-per-player index counts pending
   * orders, so their own abandoned attempt had permanently consumed the entry
   * offer they had just paid for.
   *
   * Validation is pure and needs nothing from the order, so there is no reason
   * for it to happen second. Nothing is written to disk here either, so the
   * original point of the old ordering — never leave an orphan file — still
   * holds.
   */
  const bytes = new Uint8Array(await comprobante.arrayBuffer());
  const validation = validateUpload(bytes);
  if (!validation.ok) return { error: validation.rejection.message };

  const created = await createOrder(
    { store: new DrizzleOrderingStore(getDb()) },
    {
      comboKey,
      playerId,
      playerNickname: confirmed.nickname,
      contactWhatsapp: whatsapp,
      paymentMethod: 'transfer_manual',
      source: 'storefront',
      tracking: await trackingContext(),
    },
  );

  if (!created.ok) return { error: explain(created.failure) };

  // Written after the order exists, so the file is keyed to a real order
  // number. The bytes were already validated above; `storeComprobante` checks
  // them again, which is cheap and keeps it safe to call from anywhere.
  const stored = await storeComprobante(created.order.orderNumber, bytes);

  if (!stored.ok) {
    // Only reachable now if the disk itself refused the write, since the bytes
    // passed validation moments ago. The order stands and the customer can send
    // the file over WhatsApp with their order number; the alternative — losing
    // an order somebody has already paid for — is worse.
    console.error(
      `[checkout] ${created.order.orderNumber}: could not store a valid comprobante`,
      stored.rejection,
    );
    return { error: stored.rejection.message };
  }

  await attachComprobante(created.order.id, stored.key);

  // Best-effort and deliberately not awaited: the owner asked to hear about
  // this the moment it happens rather than having to keep checking
  // Aprobaciones, but a slow or unconfigured Telegram must never delay the
  // redirect below, let alone fail an order that has already been created
  // and stored — see notifyNewOrder's own doc comment. Safe to fire and
  // forget here specifically because this is a long-running Node process
  // (Dockerfile.next's standalone server), not a serverless function that
  // could freeze before the request finishes.
  notifyNewOrder({
    orderNumber: created.order.orderNumber,
    comboName: combo.name,
    price: mxn(combo.priceMxnCents),
  }).catch(() => {
    /* notifyNewOrder already logs and never rejects; this is only a backstop. */
  });

  redirect(`/pedido/${created.order.orderNumber}?id=${encodeURIComponent(playerId)}`);
}

// ── step 2, through Stripe (card, OXXO, or SPEI — one method per button) ───────

/** Per-method copy for the one thing that actually differs between the three buttons. */
const STRIPE_METHOD_COPY: Record<
  'card' | 'oxxo' | 'spei',
  { unavailable: string; openFailed: string; verb: string }
> = {
  card: {
    unavailable: 'El pago con tarjeta no está disponible en este momento. Paga por transferencia.',
    openFailed: 'No pudimos abrir el pago con tarjeta. Intenta de nuevo o paga por transferencia.',
    verb: 'tarjeta',
  },
  oxxo: {
    unavailable: 'El depósito en OXXO no está disponible en este momento. Paga por transferencia.',
    openFailed: 'No pudimos abrir el depósito en OXXO. Intenta de nuevo o paga por transferencia.',
    verb: 'oxxo',
  },
  spei: {
    unavailable: 'La transferencia SPEI no está disponible en este momento. Paga con tarjeta.',
    openFailed: 'No pudimos abrir la transferencia SPEI. Intenta de nuevo o paga con tarjeta.',
    verb: 'spei',
  },
};

/**
 * Create the order and send the customer to Stripe's hosted Checkout,
 * restricted to exactly the one method they picked.
 *
 * The order exists before the customer pays, exactly as with a transfer: that
 * is what reserves the Mega Oferta slot against a double purchase, and what
 * the session's metadata points back at. If Stripe cannot open a session, the
 * order is cancelled on the spot — otherwise a customer who never got to pay
 * would find their entry offer "already used" for the next hour.
 *
 * `paymentMethod` is recorded as the real method chosen here, not always
 * `card` — that's also what lets Contabilidad's per-method Stripe fee
 * estimate (accounting-queries.ts) apply the right rate instead of quietly
 * costing every OXXO/SPEI sale as if it were a card one.
 */
async function payWithStripeMethod(
  method: 'card' | 'oxxo' | 'spei',
  formData: FormData,
): Promise<CheckoutState> {
  const copy = STRIPE_METHOD_COPY[method];
  const gateway = getStripe();
  if (!gateway || !gateway.supportedMethods.includes(method)) {
    return { error: copy.unavailable };
  }

  const comboKey = String(formData.get('comboKey') ?? '');
  const playerId = String(formData.get('playerId') ?? '').trim();
  const whatsapp = String(formData.get('whatsapp') ?? '').trim() || null;

  const combo = await getStorefrontCombo(getDb(), comboKey);
  if (!combo) return { error: 'Esta promoción ya no está disponible.' };

  // Same reason as the transfer path: the form is a UX gate, not a security one.
  const confirmed = await confirmPlayer(playerId);
  if (!confirmed.ok) return { error: confirmed.message };

  const created = await createOrder(
    { store: new DrizzleOrderingStore(getDb()) },
    {
      comboKey,
      playerId,
      playerNickname: confirmed.nickname,
      contactWhatsapp: whatsapp,
      paymentMethod: method,
      source: 'storefront',
      tracking: await trackingContext(),
    },
  );
  if (!created.ok) return { error: explain(created.failure) };

  const { order } = created;
  const orderPage = `/pedido/${order.orderNumber}?id=${encodeURIComponent(playerId)}`;
  let checkoutUrl: string;

  try {
    const charge = await gateway.createCharge({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountCents: order.priceMxnCents,
      method,
      description: `${combo.name} · ${diamonds(combo.advertisedDiamonds)} diamantes Free Fire`,
      customerPhone: whatsapp,
      returnUrl: siteUrl(`${orderPage}&pago=${copy.verb}`),
      cancelUrl: siteUrl(
        `/comprar/${encodeURIComponent(comboKey)}?cancelado=${encodeURIComponent(order.orderNumber)}` +
          `&id=${encodeURIComponent(playerId)}`,
      ),
    });

    if (charge.instructions.kind !== 'redirect') {
      throw new Error(`Unexpected instructions ${charge.instructions.kind}`);
    }

    const attached = await attachGatewayCharge(getDb(), {
      orderId: order.id,
      gateway: STRIPE,
      gatewayChargeId: charge.gatewayChargeId,
      expiresAt: charge.expiresAt ? new Date(charge.expiresAt.getTime() + SESSION_GRACE_MS) : null,
    });
    if (!attached) throw new Error(`Could not link ${charge.gatewayChargeId} to ${order.orderNumber}`);

    checkoutUrl = charge.instructions.url;
  } catch (err) {
    console.error(`[checkout] ${order.orderNumber}: could not open a ${method} checkout`, err);
    await rejectPayment(
      { store: new DrizzlePaymentStore(getDb()) },
      { orderId: order.id, adminUserId: null, reason: `No se pudo abrir el pago (${method})` },
    ).catch((cancelErr: unknown) =>
      console.error(`[checkout] ${order.orderNumber}: and could not cancel it`, cancelErr),
    );
    return { error: copy.openFailed };
  }

  // Returned as data, not a `redirect()` — Stripe's own hosted confirmation
  // for OXXO/SPEI does not navigate back on its own, so the client opens this
  // in a new tab and keeps the order-tracking page in the original one rather
  // than sending the whole page away to Stripe.
  return { checkoutUrl, orderPageUrl: orderPage };
}

export async function payWithCard(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  return payWithStripeMethod('card', formData);
}

export async function payWithStripeOxxo(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  return payWithStripeMethod('oxxo', formData);
}

export async function payWithStripeSpei(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  return payWithStripeMethod('spei', formData);
}

async function attachComprobante(orderId: string, key: string): Promise<void> {
  const { payments } = await import('@levelup/db');
  await getDb()
    .update(payments)
    .set({ comprobanteAssetUrl: key, status: 'under_review' })
    .where(eq(payments.orderId, orderId));
}
