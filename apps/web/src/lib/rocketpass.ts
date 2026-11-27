/**
 * RocketPass webhook configuration and alerting.
 *
 * `ROCKETPASS_WEBHOOK_SECRET` is server-side only — see `.env.example`'s own
 * note on never committing it. The route this backs refuses every request
 * (404, not even attempting signature verification) until it's set.
 */

import 'server-only';
import type { Alerter, AlertLevel } from '@levelup/engine';
import { RocketPassClient } from '@levelup/rocketpass';

export const ROCKETPASS = 'rocketpass';

export function getRocketPassWebhookSecret(): string | null {
  return process.env.ROCKETPASS_WEBHOOK_SECRET?.trim() || null;
}

declare global {
  // eslint-disable-next-line no-var
  var __webRocketPass: RocketPassClient | null | undefined;
}

function build(): RocketPassClient | null {
  const apiKey = process.env.ROCKETPASS_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = process.env.ROCKETPASS_BASE_URL?.trim() || undefined;
  return new RocketPassClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
}

/**
 * Same singleton-if-configured pattern as `lib/mercadopago.ts`'s
 * `getMercadoPago()` — null when `ROCKETPASS_API_KEY` isn't set, so a caller
 * can fall back to the item-checkout page's old behavior instead of crashing.
 * `docker-compose.prod.yml` shares one `.env` across every service, so the
 * same key already configured for `apps/worker`'s catalog sync/fulfillment
 * is available here too, no separate provisioning needed.
 */
export function getRocketPassClient(): RocketPassClient | null {
  if (globalThis.__webRocketPass !== undefined) return globalThis.__webRocketPass;
  const built = build();
  if (process.env.NODE_ENV !== 'production') globalThis.__webRocketPass = built;
  return built;
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
