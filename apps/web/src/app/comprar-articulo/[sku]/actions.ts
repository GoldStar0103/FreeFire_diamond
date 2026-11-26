'use server';

import {
  attachGatewayCharge,
  DrizzleItemOrderingStore,
  DrizzlePaymentStore,
  findResumableItemOrder,
  getArsRate,
} from '@levelup/db';
import { createItemOrder, rejectPayment, type CreateItemOrderFailure } from '@levelup/engine';
import type { PaymentInstructions } from '@levelup/payments';
import { getDb, paymentAttemptLimiter, callerIp } from '../../../lib/server';
import { getCustomerSession } from '../../../lib/customer-session';
import { siteUrl } from '../../../lib/site';
import { getStripe, SESSION_GRACE_MS, STRIPE } from '../../../lib/stripe';
import { applyMercadoPagoEmbeddedReport, getMercadoPagoEmbedded, MERCADOPAGO_EMBEDDED } from '../../../lib/mercadopago-embedded';
import { trackingContext } from '../../../lib/tracking';

export interface CheckoutState {
  error?: string;
  /** Opened in a new tab, same convention as the combo checkout. */
  checkoutUrl?: string;
  orderPageUrl?: string;
}

/**
 * Spanish for each way `createItemOrder` can refuse.
 *
 * There is no "¿Eres tú, X?" step here, unlike the combo checkout — RocketPass's
 * own API has no validate-uid endpoint (confirmed against `packages/rocketpass`),
 * only the order-time check this failure maps from. The page itself asks the
 * customer to double-check their Free Fire ID for exactly that reason.
 */
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

/**
 * Card-only for v1 (Jose's own call, 2026-11-16): it's the one instant-settle
 * method, which matters against a vendor's limited stock — a 48h manual-transfer
 * hold would risk a customer reserving an item that sells out before they pay.
 * Mirrors `comprar/[combo]/actions.ts`'s `payWithGatewayMethod` exactly, just
 * against `createItemOrder` instead of `createOrder`.
 */
export async function payWithItemCard(_prev: CheckoutState, formData: FormData): Promise<CheckoutState> {
  const gateway = getStripe();
  if (!gateway || !gateway.supportedMethods.includes('card')) {
    return { error: 'El pago con tarjeta no está disponible en este momento.' };
  }

  const sku = String(formData.get('sku') ?? '');
  const targetUid = String(formData.get('targetUid') ?? '').trim();
  const targetNickname = String(formData.get('targetNickname') ?? '').trim() || null;
  const region = String(formData.get('region') ?? '').trim() || null;
  const quantity = Number(formData.get('quantity') ?? 1);
  const whatsapp = String(formData.get('whatsapp') ?? '').trim() || null;

  if (!whatsapp) {
    return { error: 'Ingresa tu número de WhatsApp para poder contactarte si hace falta.' };
  }

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
        region,
        targetUid,
        targetNickname,
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
      returnUrl: siteUrl(`${orderPage}&pago=tarjeta`),
      cancelUrl: siteUrl(
        `/comprar-articulo/${encodeURIComponent(sku)}?cancelado=${encodeURIComponent(order.orderNumber)}`,
      ),
    });

    if (charge.instructions.kind !== 'redirect') {
      throw new Error(`Unexpected instructions ${charge.instructions.kind}`);
    }

    const attached = await attachGatewayCharge(db, {
      orderId: order.id,
      gateway: STRIPE,
      gatewayChargeId: charge.gatewayChargeId,
      expiresAt: charge.expiresAt ? new Date(charge.expiresAt.getTime() + SESSION_GRACE_MS) : null,
      ...(resumable ? { method: 'card' as const } : {}),
    });
    if (!attached) throw new Error(`Could not link ${charge.gatewayChargeId} to ${order.orderNumber}`);

    return { checkoutUrl: charge.instructions.url, orderPageUrl: orderPage };
  } catch (err) {
    console.error(`[comprar-articulo] ${order.orderNumber}: could not open a Stripe/card checkout`, err);
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
  const targetNickname = String(formData.get('targetNickname') ?? '').trim() || null;
  const region = String(formData.get('region') ?? '').trim() || null;
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
        region,
        targetUid,
        targetNickname,
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
