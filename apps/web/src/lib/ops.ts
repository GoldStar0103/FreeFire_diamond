/**
 * Telling a human, from the storefront.
 *
 * The worker has its own alerter; the storefront needs one for exactly one
 * situation — a card payment that arrived and could not be approved. That is a
 * customer who has paid and will receive nothing until somebody looks, and a
 * console line on a server nobody tails is not somebody looking.
 *
 * Never throws. An alert that fails must not turn into a 500 on the webhook,
 * which would make Stripe redeliver an event we have in fact handled.
 */

import 'server-only';

export type OpsLevel = 'warn' | 'critical';

export async function notifyOps(
  level: OpsLevel,
  title: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const line = `[ops:${level}] ${title} ${JSON.stringify(detail)}`;
  if (level === 'critical') console.error(line);
  else console.warn(line);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chatId) return;

  const text =
    `${level === 'critical' ? '🚨' : '⚠️'} ${title}\n` +
    Object.entries(detail)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n');

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.error(`[ops] Telegram alert failed: ${String(err)}`);
  }
}
