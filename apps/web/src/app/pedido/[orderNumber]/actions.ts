'use server';

import { attachGatewayCharge, DrizzlePaymentStore, findPendingOrderForAction } from '@levelup/db';
import { rejectPayment } from '@levelup/engine';
import { diamonds } from '../../../lib/format';
import { callerIp, getDb, lookupLimiter } from '../../../lib/server';
import { getStripe, SESSION_GRACE_MS, STRIPE } from '../../../lib/stripe';
import { getMercadoPago, MERCADOPAGO } from '../../../lib/mercadopago';
import { siteUrl } from '../../../lib/site';

export interface ContinueState {
  error?: string;
  checkoutUrl?: string;
  orderPageUrl?: string;
}

const GATEWAY_METHODS = new Set(['card', 'oxxo', 'spei']);

/**
 * "Continuar pago" — mints a fresh gateway checkout session for an order
 * that already exists, instead of making the customer start over from
 * `/comprar/[combo]` (which would create a second order for the same combo).
 *
 * Only ever touches orders paid through a gateway (card/OXXO/SPEI). A manual
 * transfer order already got its comprobante at creation time — see
 * `placeOrder` — so there is nothing to resume there; that status is almost
 * never actually visible to a customer (see `storefront-queries.ts`), and
 * if it somehow is, the only thing to do is write to the order's own
 * WhatsApp support link, not retry a gateway nothing opened in the first
 * place.
 */
export async function continuePendingOrder(
  _prev: ContinueState,
  formData: FormData,
): Promise<ContinueState> {
  const orderNumber = String(formData.get('orderNumber') ?? '').trim();
  const playerId = String(formData.get('playerId') ?? '').trim();
  if (!orderNumber || !playerId) return { error: 'Pedido no encontrado.' };

  const order = await findPendingOrderForAction(getDb(), orderNumber, playerId);
  if (!order) {
    // Same miss-only throttle `pedido/[orderNumber]/page.tsx` applies to a
    // bad order-number+ID pairing — a customer's own valid pedido never hits
    // this, only a guess against an unrelated one.
    lookupLimiter.check(await callerIp());
    return { error: 'Pedido no encontrado.' };
  }

  if (order.orderStatus !== 'pending_payment' || order.paymentStatus !== 'pending') {
    return { error: 'Este pedido ya no está esperando pago.' };
  }
  if (!order.paymentMethod || !GATEWAY_METHODS.has(order.paymentMethod) || !order.comboKey) {
    return { error: 'Este pedido no se puede continuar aquí. Escríbenos por WhatsApp.' };
  }
  if (order.expiresAt && order.expiresAt < new Date()) {
    return { error: 'El tiempo para pagar este pedido ya venció.' };
  }

  const method = order.paymentMethod as 'card' | 'oxxo' | 'spei';
  const gatewayName = order.gateway;
  const gateway = gatewayName === STRIPE ? getStripe() : gatewayName === MERCADOPAGO ? getMercadoPago() : null;
  if (!gateway || !gateway.supportedMethods.includes(method)) {
    return { error: 'Este método de pago ya no está disponible. Escríbenos por WhatsApp.' };
  }

  const orderPage = `/pedido/${order.orderNumber}?id=${encodeURIComponent(playerId)}`;

  try {
    const charge = await gateway.createCharge({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountCents: order.priceMxnCents,
      method,
      description: `${order.comboName} · ${diamonds(order.advertisedDiamonds)} diamantes Free Fire`,
      customerPhone: order.contactWhatsapp,
      returnUrl: siteUrl(orderPage),
      cancelUrl: siteUrl(orderPage),
    });

    if (charge.instructions.kind !== 'redirect') {
      throw new Error(`Unexpected instructions ${charge.instructions.kind}`);
    }

    const attached = await attachGatewayCharge(getDb(), {
      orderId: order.id,
      gateway: gatewayName as string,
      gatewayChargeId: charge.gatewayChargeId,
      expiresAt: charge.expiresAt ? new Date(charge.expiresAt.getTime() + SESSION_GRACE_MS) : null,
    });
    if (!attached) return { error: 'Este pedido ya no está esperando pago.' };

    return { checkoutUrl: charge.instructions.url, orderPageUrl: orderPage };
  } catch (err) {
    console.error(`[pedido] ${order.orderNumber}: could not reopen a ${gatewayName}/${method} checkout`, err);
    return { error: 'No pudimos abrir el pago. Intenta de nuevo o escríbenos por WhatsApp.' };
  }
}

export interface CancelState {
  error?: string;
  ok?: boolean;
}

/**
 * "Cancelar" on a pending order — only ever reachable for a manual-transfer
 * order still awaiting a comprobante (or one under review the customer wants
 * to withdraw). `rejectPayment` itself already refuses card/OXXO/SPEI — those
 * settle themselves through the gateway's webhook and have nothing to
 * cancel by hand — so this is a thin, customer-facing wrapper around the same
 * guard the admin panel's own reject action uses.
 */
export async function cancelPendingOrder(_prev: CancelState, formData: FormData): Promise<CancelState> {
  const orderNumber = String(formData.get('orderNumber') ?? '').trim();
  const playerId = String(formData.get('playerId') ?? '').trim();
  if (!orderNumber || !playerId) return { error: 'Pedido no encontrado.' };

  const order = await findPendingOrderForAction(getDb(), orderNumber, playerId);
  if (!order) {
    lookupLimiter.check(await callerIp());
    return { error: 'Pedido no encontrado.' };
  }

  const result = await rejectPayment(
    { store: new DrizzlePaymentStore(getDb()) },
    { orderId: order.id, adminUserId: null, reason: 'Cancelado por el cliente' },
  );

  if (!result.ok) {
    const message =
      result.failure.code === 'CARD_PAYMENT_NOT_REJECTABLE'
        ? 'Este pedido se paga automáticamente — no se puede cancelar. Espera a que venza o escríbenos por WhatsApp.'
        : 'Este pedido ya no se puede cancelar.';
    return { error: message };
  }

  return { ok: true };
}
