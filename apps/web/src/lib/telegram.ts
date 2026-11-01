/**
 * "A new order is waiting for you" — Telegram.
 *
 * Deliberately not the engine's `Alerter` (info/warn/critical across every
 * fulfilment failure mode): that abstraction belongs to the worker, the only
 * thing that already depends on it, and reaching for it here would make
 * `@levelup/shared` depend on `@levelup/engine` — which already depends on
 * `@levelup/shared` for `checkRecipe`. One storefront event with nothing to
 * choose a level for does not need that abstraction; a plain function does.
 *
 * Optional by design, the opposite of the worker's own alerts: the worker
 * refuses to start without Telegram configured, because a fulfilment failure
 * nobody hears about is the whole system failing quietly. A missed "hey, a
 * customer paid" ping is not that — checkout must never fail, or make a
 * customer wait, because Telegram is slow or unconfigured.
 */
export interface NewOrderNotice {
  orderNumber: string;
  comboName: string;
  price: string;
}

async function sendTelegramNotice(text: string, label: string, fetchImpl: typeof fetch): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[telegram] ${label} notice rejected: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[telegram] could not send ${label} notice: ${String(err)}`);
  }
}

/** The manual transfer/OXXO flow — needs a human to check the comprobante. */
export async function notifyNewOrder(
  notice: NewOrderNotice,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const text = [
    '🛒 Nuevo pedido esperando aprobación',
    `Pedido: ${notice.orderNumber}`,
    `Paquete: ${notice.comboName}`,
    `Monto: ${notice.price}`,
  ].join('\n');
  await sendTelegramNotice(text, 'new-order', fetchImpl);
}

/**
 * Seen user agents that already triggered `notifyStuckGatewayRedirect` this
 * process lifetime. In-memory and reset on every deploy/restart — not meant
 * to be durable, only to stop one broken in-app browser from paging a human
 * once per customer who hits it instead of once per app.
 */
const alertedStuckRedirectUserAgents = new Set<string>();

/**
 * `useStripeTabRedirect` (checkout.tsx) opens a popup for the payment gateway
 * and falls back to a same-tab redirect if that popup is still stuck on
 * `about:blank` a moment later — the symptom of an in-app browser that
 * handed `window.open()` to a process it can no longer drive (WhatsApp did
 * this on 2026-11-01; see `lib/in-app-browser.ts`). The customer recovers on
 * their own by the time this fires — this exists only so a human learns
 * which app it was, instead of finding out from a support screenshot days
 * later.
 */
export async function notifyStuckGatewayRedirect(
  userAgent: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (alertedStuckRedirectUserAgents.has(userAgent)) return;
  alertedStuckRedirectUserAgents.add(userAgent);

  const text = [
    '🧩 Pago atorado en una pestaña emergente (el cliente se recuperó solo)',
    `User agent: ${userAgent}`,
  ].join('\n');
  await sendTelegramNotice(text, 'stuck-gateway-redirect', fetchImpl);
}

/** One line per method — was hardcoded to the card wording alone until OXXO/SPEI got real methods. */
const GATEWAY_SALE_HEADLINE: Record<string, string> = {
  card: '✅ Venta con tarjeta',
  oxxo: '✅ Venta con OXXO',
  spei: '✅ Venta por transferencia SPEI',
};

/**
 * A Stripe-settled payment — card, OXXO, or SPEI — that just went through.
 * Distinct wording from `notifyNewOrder` on purpose — nobody needs to approve
 * this one, the recharge is already on its way, so "esperando aprobación"
 * would be actively misleading here.
 */
export async function notifyGatewaySale(
  notice: NewOrderNotice & { method: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const text = [
    GATEWAY_SALE_HEADLINE[notice.method] ?? '✅ Venta confirmada',
    `Pedido: ${notice.orderNumber}`,
    `Paquete: ${notice.comboName}`,
    `Monto: ${notice.price}`,
  ].join('\n');
  await sendTelegramNotice(text, 'gateway-sale', fetchImpl);
}
