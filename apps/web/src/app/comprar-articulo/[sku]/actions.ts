'use server';

import {
  attachGatewayCharge,
  DrizzleItemOrderingStore,
  DrizzlePaymentStore,
  extendPaymentDeadline,
  findGatewayPayment,
  findResumableItemOrder,
  getArsRate,
} from '@levelup/db';
import { createItemOrder, rejectPayment, type CreateItemOrderFailure } from '@levelup/engine';
import type { RocketPassRegion } from '@levelup/rocketpass';
import type { ChargeState, PaymentInstructions } from '@levelup/payments';
import { getDb, paymentAttemptLimiter, callerIp, validationLimiter } from '../../../lib/server';
import { getRocketPassClient } from '../../../lib/rocketpass';
import { getCustomerSession } from '../../../lib/customer-session';
import { siteUrl } from '../../../lib/site';
import { applyStripeReport, getStripe, SESSION_GRACE_MS, STRIPE } from '../../../lib/stripe';
import { getMercadoPago, MERCADOPAGO } from '../../../lib/mercadopago';
import { applyMercadoPagoEmbeddedReport, getMercadoPagoEmbedded, MERCADOPAGO_EMBEDDED } from '../../../lib/mercadopago-embedded';
import { trackingContext } from '../../../lib/tracking';

export interface CheckoutState {
  error?: string;
  /** Opened in a new tab, same convention as the combo checkout. */
  checkoutUrl?: string;
  orderPageUrl?: string;
}

// ── step 1: who is this player? ───────────────────────────────────────────────
//
// RocketPass's own `GET /players/{uid}` (confirmed against the live API
// 2026-11-26, see `packages/rocketpass/src/types.ts`'s `PlayerLookup` doc
// comment) does what the combo checkout's generic diamond-provider lookup
// never could for this page: it returns the account's real RocketPass
// region regardless of what's asked for, not just a nickname. So the region
// picker that used to be a manual, error-prone choice is gone entirely —
// verifying the ID is now also how the region gets decided, closing both of
// Jose's reports at once ("no id validator") and ("auto-detect the region").

export interface ValidateState {
  status: 'idle' | 'found' | 'not_found' | 'error';
  playerId?: string;
  nickname?: string | null;
  level?: number | null;
  avatarUrl?: string | null;
  /** The account's real RocketPass region — only meaningful for `kind === 'gift'`. */
  region?: RocketPassRegion | null;
  message?: string;
}

/** Item-checkout counterpart of the combo checkout's `validatePlayer` — see that function's own doc comment. */
export async function validateItemPlayer(
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

  const rocketPass = getRocketPassClient();
  if (!rocketPass) {
    return { status: 'error', message: 'No podemos verificar tu ID en este momento. Intenta más tarde.' };
  }

  try {
    const player = await rocketPass.getPlayer(playerId);
    if (!player.valid || !player.found) {
      return {
        status: 'not_found',
        playerId,
        message: player.error ?? 'No encontramos ese ID. Revísalo e intenta de nuevo.',
      };
    }
    return {
      status: 'found',
      playerId,
      nickname: player.nickname,
      level: player.level,
      avatarUrl: player.avatarUrl,
      region: player.region,
    };
  } catch (err) {
    console.error('[comprar-articulo] RocketPass player lookup failed', err);
    return { status: 'error', message: 'No pudimos contactar al servidor de Free Fire. Intenta en un momento.' };
  }
}

type ConfirmResult =
  | { ok: true; nickname: string | null; region: RocketPassRegion | null }
  | { ok: false; message: string };

/**
 * Re-confirm the player server-side, same discipline as the combo checkout's
 * own `confirmPlayer` — a server action is a public endpoint, so the
 * Verificar step above is a UX gate, not a security one. Every `payWithItem*`
 * action below calls this before creating an order, and uses its nickname
 * AND region (never client-supplied) as what the order is actually built from
 * — `createItemOrder` ignores `region` for anything but a `gift` item, so
 * passing it unconditionally here is harmless for a membership order.
 */
async function confirmItemPlayer(playerId: string): Promise<ConfirmResult> {
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

  const rocketPass = getRocketPassClient();
  if (!rocketPass) {
    return { ok: false, message: 'No podemos verificar tu ID en este momento.' };
  }

  try {
    const player = await rocketPass.getPlayer(playerId);
    if (!player.valid || !player.found) {
      return { ok: false, message: player.error ?? 'No encontramos ese ID de Free Fire. Revísalo por favor.' };
    }
    return { ok: true, nickname: player.nickname, region: player.region };
  } catch (err) {
    console.error('[comprar-articulo] player re-validation failed', err);
    return { ok: false, message: 'No pudimos verificar tu cuenta ahora mismo. Intenta en un momento.' };
  }
}

/** Spanish for each way `createItemOrder` can refuse. */
function explain(failure: CreateItemOrderFailure): string {
  switch (failure.code) {
    case 'ITEM_NOT_FOUND':
    case 'ITEM_INACTIVE':
    case 'ITEM_UNAVAILABLE':
    case 'PRICE_NOT_SET':
      return 'Este artículo ya no está disponible.';
    case 'OUT_OF_STOCK':
      return 'Se agotó el stock de este artículo en esa región. Prueba con otra región o más tarde.';
    case 'INVALID_QUANTITY':
      return `La cantidad debe ser entre 1 y ${failure.max}.`;
    case 'REGION_REQUIRED':
      return 'Elige una región.';
    case 'INVALID_PLAYER_ID':
      return 'El ID de jugador no es válido.';
    default:
      console.error('[comprar-articulo] order creation failed', failure);
      return 'No pudimos crear tu pedido. Escríbenos por WhatsApp y lo resolvemos.';
  }
}

export interface StripeItemCardCheckoutState {
  error?: string;
  clientSecret?: string;
  gatewayChargeId?: string;
  orderNumber?: string;
  targetUid?: string;
  orderPageUrl?: string;
}

const STRIPE_ITEM_CARD_COPY = {
  unavailable: 'El pago con tarjeta no está disponible en este momento.',
};

/**
 * Card-only for v1 (Jose's own call, 2026-11-16): it's the one instant-settle
 * method, which matters against a vendor's limited stock — a 48h manual-transfer
 * hold would risk a customer reserving an item that sells out before they pay.
 * Mirrors the combo checkout's own `payWithStripeCard` exactly, just against
 * `createItemOrder` instead of `createOrder` — see that function's own doc
 * comment for why this is a `clientSecret`, not an already-known outcome.
 */
export async function payWithItemStripeCard(
  _prev: StripeItemCardCheckoutState,
  formData: FormData,
): Promise<StripeItemCardCheckoutState> {
  const gateway = getStripe();
  if (!gateway || !gateway.supportedMethods.includes('card')) {
    return { error: STRIPE_ITEM_CARD_COPY.unavailable };
  }

  const sku = String(formData.get('sku') ?? '');
  const targetUid = String(formData.get('targetUid') ?? '').trim();
  const quantity = Number(formData.get('quantity') ?? 1);
  const whatsapp = String(formData.get('whatsapp') ?? '').trim() || null;

  if (!whatsapp) {
    return { error: 'Ingresa tu número de WhatsApp para poder contactarte si hace falta.' };
  }

  const confirmed = await confirmItemPlayer(targetUid);
  if (!confirmed.ok) return { error: confirmed.message };

  const db = getDb();

  // Reuse a still-genuinely-untouched pending order for this exact sku instead
  // of inserting a second one — see `findResumableItemOrder`'s own doc comment.
  const resumable = await findResumableItemOrder(db, { playerId: targetUid, sku });

  let order: { id: string; orderNumber: string; priceMxnCents: number; itemName: string };
  if (resumable) {
    order = resumable;
  } else {
    const arsRate = await getArsRate(db);
    const buyer = await getCustomerSession();
    const created = await createItemOrder(
      { store: new DrizzleItemOrderingStore(db), arsRate },
      {
        sku,
        quantity,
        region: confirmed.region,
        targetUid,
        targetNickname: confirmed.nickname,
        contactWhatsapp: whatsapp,
        paymentMethod: 'card',
        source: 'storefront',
        tracking: await trackingContext(),
        buyerProfileId: buyer?.playerProfileId ?? null,
      },
    );
    if (!created.ok) return { error: explain(created.failure) };
    order = { ...created.order, itemName: created.order.item.itemName };
  }

  const orderPage = `/pedido/${order.orderNumber}?id=${encodeURIComponent(targetUid)}`;

  try {
    const charge = await gateway.createCharge({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountCents: order.priceMxnCents,
      method: 'card',
      description: `${order.itemName} · LevelUp Store`,
      customerPhone: whatsapp,
    });

    if (charge.instructions.kind !== 'stripe_elements') {
      throw new Error(`Unexpected instructions ${charge.instructions.kind}`);
    }

    const attached = await attachGatewayCharge(db, {
      orderId: order.id,
      gateway: STRIPE,
      gatewayChargeId: charge.gatewayChargeId,
      expiresAt: null,
      ...(resumable ? { method: 'card' as const } : {}),
    });
    if (!attached) throw new Error(`Could not link ${charge.gatewayChargeId} to ${order.orderNumber}`);

    // See the combo checkout's own `payWithStripeCard` for why this matters:
    // a PaymentIntent has no session expiry to lean on, and Stripe's own
    // async capture can report the final status minutes after confirm.
    const linked = await findGatewayPayment(db, STRIPE, charge.gatewayChargeId);
    if (linked) {
      await extendPaymentDeadline(db, linked.paymentId, new Date(Date.now() + SESSION_GRACE_MS));
    }

    return {
      clientSecret: charge.instructions.clientSecret,
      gatewayChargeId: charge.gatewayChargeId,
      orderNumber: order.orderNumber,
      targetUid,
      orderPageUrl: orderPage,
    };
  } catch (err) {
    console.error(`[comprar-articulo] ${order.orderNumber}: could not open a stripe/card (embedded) charge`, err);
    if (!resumable) {
      await rejectPayment(
        { store: new DrizzlePaymentStore(db) },
        { orderId: order.id, adminUserId: null, reason: 'No se pudo abrir el pago (card)' },
      ).catch((cancelErr: unknown) =>
        console.error(`[comprar-articulo] ${order.orderNumber}: and could not cancel it`, cancelErr),
      );
    }
    return { error: 'No pudimos abrir el pago con tarjeta. Intenta de nuevo.' };
  }
}

export interface StripeItemCardResultState {
  error?: string;
  state?: ChargeState;
  orderPageUrl?: string;
}

/** The item-checkout counterpart of the combo checkout's `confirmStripeCardPayment` — see its own doc comment. */
export async function confirmItemStripeCardPayment(
  _prev: StripeItemCardResultState,
  formData: FormData,
): Promise<StripeItemCardResultState> {
  const gateway = getStripe();
  if (!gateway) return { error: STRIPE_ITEM_CARD_COPY.unavailable };

  const gatewayChargeId = String(formData.get('gatewayChargeId') ?? '').trim();
  const orderNumber = String(formData.get('orderNumber') ?? '').trim();
  const targetUid = String(formData.get('targetUid') ?? '').trim();
  if (!gatewayChargeId || !orderNumber) return { error: 'Falta información del pago.' };

  const orderPageUrl = `/pedido/${orderNumber}?id=${encodeURIComponent(targetUid)}`;

  let snapshot;
  try {
    snapshot = await gateway.getCharge(gatewayChargeId);
  } catch (err) {
    console.error(`[comprar-articulo] ${orderNumber}: could not re-check a Stripe card result`, err);
    return { orderPageUrl };
  }
  if (!snapshot) {
    return { error: 'No pudimos confirmar tu pago. Intenta de nuevo o escríbenos por WhatsApp.' };
  }

  await applyStripeReport({
    gatewayChargeId: snapshot.gatewayChargeId,
    state: snapshot.state,
    amountReceivedCents: snapshot.amountReceivedCents,
    reference: snapshot.reference ?? null,
    orderNumber,
    voucherIssued: false,
  });

  if (snapshot.state === 'failed') {
    return { error: 'Tu banco rechazó el pago. Revisa los datos de tu tarjeta o intenta con otra.' };
  }

  return { state: snapshot.state, orderPageUrl };
}

/**
 * Card through Mercado Pago's hosted Checkout Pro — mirrors `payWithItemCard`
 * exactly, just against the Checkout-Pro gateway instance instead of Stripe's.
 * A second, explicit card option, not a fallback — see the combo checkout's
 * own `payWithMercadoPagoCardCheckoutPro` and mercadopago.ts's doc comment
 * for why this exists alongside Stripe.
 */
export async function payWithItemMercadoPagoCardCheckoutPro(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const gateway = getMercadoPago();
  if (!gateway || !gateway.supportedMethods.includes('card')) {
    return { error: 'El pago con tarjeta por Mercado Pago no está disponible en este momento.' };
  }

  const sku = String(formData.get('sku') ?? '');
  const targetUid = String(formData.get('targetUid') ?? '').trim();
  const quantity = Number(formData.get('quantity') ?? 1);
  const whatsapp = String(formData.get('whatsapp') ?? '').trim() || null;

  if (!whatsapp) {
    return { error: 'Ingresa tu número de WhatsApp para poder contactarte si hace falta.' };
  }

  const confirmed = await confirmItemPlayer(targetUid);
  if (!confirmed.ok) return { error: confirmed.message };

  const db = getDb();
  const resumable = await findResumableItemOrder(db, { playerId: targetUid, sku });

  let order: { id: string; orderNumber: string; priceMxnCents: number; itemName: string };
  if (resumable) {
    order = resumable;
  } else {
    const arsRate = await getArsRate(db);
    const buyer = await getCustomerSession();
    const created = await createItemOrder(
      { store: new DrizzleItemOrderingStore(db), arsRate },
      {
        sku,
        quantity,
        region: confirmed.region,
        targetUid,
        targetNickname: confirmed.nickname,
        contactWhatsapp: whatsapp,
        paymentMethod: 'card',
        source: 'storefront',
        tracking: await trackingContext(),
        buyerProfileId: buyer?.playerProfileId ?? null,
      },
    );
    if (!created.ok) return { error: explain(created.failure) };
    order = { ...created.order, itemName: created.order.item.itemName };
  }

  const orderPage = `/pedido/${order.orderNumber}?id=${encodeURIComponent(targetUid)}`;

  try {
    const charge = await gateway.createCharge({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountCents: order.priceMxnCents,
      method: 'card',
      description: `${order.itemName} · LevelUp Store`,
      customerPhone: whatsapp,
      returnUrl: siteUrl(`${orderPage}&pago=card`),
      cancelUrl: siteUrl(
        `/comprar-articulo/${encodeURIComponent(sku)}?cancelado=${encodeURIComponent(order.orderNumber)}`,
      ),
    });

    if (charge.instructions.kind !== 'redirect') {
      throw new Error(`Unexpected instructions ${charge.instructions.kind}`);
    }

    const attached = await attachGatewayCharge(db, {
      orderId: order.id,
      gateway: MERCADOPAGO,
      gatewayChargeId: charge.gatewayChargeId,
      // Mercado Pago's Preference hands back no real expiry — same as the
      // combo checkout's shared payWithGatewayMethod.
      expiresAt: null,
      ...(resumable ? { method: 'card' as const } : {}),
    });
    if (!attached) throw new Error(`Could not link ${charge.gatewayChargeId} to ${order.orderNumber}`);

    return { checkoutUrl: charge.instructions.url, orderPageUrl: orderPage };
  } catch (err) {
    console.error(`[comprar-articulo] ${order.orderNumber}: could not open a Mercado Pago/card checkout`, err);
    if (!resumable) {
      await rejectPayment(
        { store: new DrizzlePaymentStore(db) },
        { orderId: order.id, adminUserId: null, reason: 'No se pudo abrir el pago (card)' },
      ).catch((cancelErr: unknown) =>
        console.error(`[comprar-articulo] ${order.orderNumber}: and could not cancel it`, cancelErr),
      );
    }
    return { error: 'No pudimos abrir el pago con tarjeta. Intenta de nuevo.' };
  }
}

// ── card, through Mercado Pago's embedded Checkout ─────────────────────────────

export interface EmbeddedCheckoutState {
  error?: string;
  instructions?: PaymentInstructions;
  orderPageUrl?: string;
}

/**
 * The embedded-checkout counterpart of `payWithItemCard`, mirroring
 * `comprar/[combo]/actions.ts`'s `payWithEmbeddedMethod` — see that file's
 * own doc comment for why this settles synchronously instead of returning a
 * redirect URL. Card-only here too, same reason `payWithItemCard` already is:
 * it is the one instant-settle method against a vendor's limited stock.
 */
export async function payWithItemMercadoPagoCard(
  _prev: EmbeddedCheckoutState,
  formData: FormData,
): Promise<EmbeddedCheckoutState> {
  const gateway = getMercadoPagoEmbedded();
  if (!gateway || !gateway.supportedMethods.includes('card')) {
    return { error: 'El pago con tarjeta no está disponible en este momento.' };
  }

  const sku = String(formData.get('sku') ?? '');
  const targetUid = String(formData.get('targetUid') ?? '').trim();
  const quantity = Number(formData.get('quantity') ?? 1);
  const whatsapp = String(formData.get('whatsapp') ?? '').trim() || null;
  const deviceSessionId = String(formData.get('deviceSessionId') ?? '').trim() || null;
  const cardToken = String(formData.get('cardToken') ?? '').trim() || null;
  const paymentMethodId = String(formData.get('paymentMethodId') ?? '').trim() || null;
  const rawInstallments = Number(formData.get('installments'));
  const installments = Number.isInteger(rawInstallments) && rawInstallments > 0 ? rawInstallments : 1;
  const payerEmail = String(formData.get('payerEmail') ?? '').trim() || null;
  const payerIdentificationType = String(formData.get('payerIdentificationType') ?? '').trim();
  const payerIdentificationNumber = String(formData.get('payerIdentificationNumber') ?? '').trim();
  const payerIdentification =
    payerIdentificationType && payerIdentificationNumber
      ? { type: payerIdentificationType, number: payerIdentificationNumber }
      : null;

  if (!whatsapp) {
    return { error: 'Ingresa tu número de WhatsApp para poder contactarte si hace falta.' };
  }
  if (!cardToken) {
    return { error: 'No pudimos procesar tu tarjeta. Revisa los datos o intenta con otra.' };
  }

  const rateDecision = paymentAttemptLimiter.check(await callerIp());
  if (!rateDecision.allowed) {
    return { error: `Demasiados intentos. Espera ${Math.ceil(rateDecision.retryAfterMs / 1000)} segundos.` };
  }

  const confirmed = await confirmItemPlayer(targetUid);
  if (!confirmed.ok) return { error: confirmed.message };

  const db = getDb();
  const resumable = await findResumableItemOrder(db, { playerId: targetUid, sku });

  let order: { id: string; orderNumber: string; priceMxnCents: number; itemName: string };
  if (resumable) {
    order = resumable;
  } else {
    const arsRate = await getArsRate(db);
    const buyer = await getCustomerSession();
    const created = await createItemOrder(
      { store: new DrizzleItemOrderingStore(db), arsRate },
      {
        sku,
        quantity,
        region: confirmed.region,
        targetUid,
        targetNickname: confirmed.nickname,
        contactWhatsapp: whatsapp,
        paymentMethod: 'card',
        source: 'storefront',
        tracking: await trackingContext(),
        buyerProfileId: buyer?.playerProfileId ?? null,
      },
    );
    if (!created.ok) return { error: explain(created.failure) };
    order = { ...created.order, itemName: created.order.item.itemName };
  }

  const orderPage = `/pedido/${order.orderNumber}?id=${encodeURIComponent(targetUid)}`;

  try {
    const charge = await gateway.createCharge({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountCents: order.priceMxnCents,
      method: 'card',
      description: `${order.itemName} · LevelUp Store`,
      customerPhone: whatsapp,
      deviceSessionId,
      cardToken,
      ...(paymentMethodId ? { paymentMethodId } : {}),
      installments,
      customerEmail: payerEmail,
      ...(payerIdentification ? { payerIdentification } : {}),
    });

    if (charge.instructions.kind !== 'resolved') {
      throw new Error(`Unexpected instructions ${charge.instructions.kind}`);
    }

    const attached = await attachGatewayCharge(db, {
      orderId: order.id,
      gateway: MERCADOPAGO_EMBEDDED,
      gatewayChargeId: charge.gatewayChargeId,
      expiresAt: charge.expiresAt,
      ...(resumable ? { method: 'card' as const } : {}),
    });
    if (!attached) throw new Error(`Could not link ${charge.gatewayChargeId} to ${order.orderNumber}`);

    await applyMercadoPagoEmbeddedReport({
      gatewayChargeId: charge.gatewayChargeId,
      state: charge.instructions.state,
      amountReceivedCents: charge.instructions.state === 'paid' ? charge.amountCents : null,
      reference: charge.instructions.reference,
      orderNumber: order.orderNumber,
      voucherIssued: false,
    });

    return { instructions: charge.instructions, orderPageUrl: orderPage };
  } catch (err) {
    console.error(`[comprar-articulo] ${order.orderNumber}: could not process a ${MERCADOPAGO_EMBEDDED}/card charge`, err);
    if (!resumable) {
      await rejectPayment(
        { store: new DrizzlePaymentStore(db) },
        { orderId: order.id, adminUserId: null, reason: 'No se pudo procesar el pago (card)' },
      ).catch((cancelErr: unknown) =>
        console.error(`[comprar-articulo] ${order.orderNumber}: and could not cancel it`, cancelErr),
      );
    }
    return { error: 'No pudimos procesar tu tarjeta. Revisa los datos o intenta con otra.' };
  }
}
