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

export async function notifyNewOrder(
  notice: NewOrderNotice,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chatId) return;

  const text = [
    '🛒 Nuevo pedido esperando aprobación',
    `Pedido: ${notice.orderNumber}`,
    `Paquete: ${notice.comboName}`,
    `Monto: ${notice.price}`,
  ].join('\n');

  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[telegram] new-order notice rejected: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[telegram] could not send new-order notice: ${String(err)}`);
  }
}
