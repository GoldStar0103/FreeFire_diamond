/**
 * RocketPass webhook configuration and alerting.
 *
 * `ROCKETPASS_WEBHOOK_SECRET` is server-side only — see `.env.example`'s own
 * note on never committing it. The route this backs refuses every request
 * (404, not even attempting signature verification) until it's set.
 */

import 'server-only';
import type { Alerter, AlertLevel } from '@levelup/engine';

export const ROCKETPASS = 'rocketpass';

export function getRocketPassWebhookSecret(): string | null {
  return process.env.ROCKETPASS_WEBHOOK_SECRET?.trim() || null;
}

const LEVEL_EMOJI: Record<AlertLevel, string> = { info: 'ℹ️', warn: '⚠️', critical: '🚨' };

/**
 * A minimal `Alerter` for the webhook route only — reuses the same Telegram
 * bot already configured for order notices (`lib/telegram.ts`'s own
 * `TELEGRAM_BOT_TOKEN`/`TELEGRAM_ALERT_CHAT_ID`), not the worker's
 * `ConsoleAlerter`/`TelegramAlerter` (those live in `apps/worker` and are
 * never imported from here). A missing token logs instead of silently
 * dropping the alert — this route has no other way to be heard.
 */
export const rocketpassAlerter: Alerter = {
  async send(level, title, detail) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
    if (!token || !chatId) {
      console.error(`[rocketpass] ${level}: ${title}`, detail ?? {});
      return;
    }

    const lines = [`${LEVEL_EMOJI[level]} RocketPass: ${title}`];
    if (detail && Object.keys(detail).length > 0) lines.push(JSON.stringify(detail));

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error(`[rocketpass] alert rejected: HTTP ${res.status}`);
    } catch (err) {
      console.error(`[rocketpass] could not send alert: ${String(err)}`);
    }
  },
};
