/**
 * Alerting.
 *
 * The client lives on WhatsApp and runs the business from a phone, so an alert
 * that only reaches a log file reaches nobody. Telegram is the pragmatic
 * choice: a free bot API, no approval process, and it works from a VPS with no
 * outbound mail configuration.
 *
 * Alerting must never take the worker down. A failure to notify is logged and
 * swallowed — losing an alert is bad, crashing mid-combo is worse.
 */

import type { Alerter, AlertLevel } from '@levelup/engine';

const ICONS: Record<AlertLevel, string> = {
  info: 'i',
  warn: '!',
  critical: 'X',
};

export class ConsoleAlerter implements Alerter {
  async send(level: AlertLevel, title: string, detail?: Record<string, unknown>): Promise<void> {
    const line = `[${ICONS[level]}] ${title}`;
    const body = detail ? ` ${JSON.stringify(detail)}` : '';
    if (level === 'critical') console.error(line + body);
    else if (level === 'warn') console.warn(line + body);
    else console.log(line + body);
  }
}

export interface TelegramAlerterOptions {
  botToken: string;
  chatId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TelegramAlerter implements Alerter {
  private readonly fallback = new ConsoleAlerter();

  constructor(private readonly options: TelegramAlerterOptions) {}

  async send(level: AlertLevel, title: string, detail?: Record<string, unknown>): Promise<void> {
    // Always log locally too, so the VPS has a record even if Telegram is down.
    await this.fallback.send(level, title, detail);

    const lines = [`${ICONS[level] === 'X' ? '🚨' : ICONS[level] === '!' ? '⚠️' : 'ℹ️'} ${title}`];
    for (const [key, value] of Object.entries(detail ?? {})) {
      lines.push(`${key}: ${String(value)}`);
    }

    const send = this.options.fetchImpl ?? fetch;
    try {
      const res = await send(`https://api.telegram.org/bot${this.options.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.options.chatId, text: lines.join('\n') }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
      if (!res.ok) {
        console.error(`[alert] Telegram rejected the message: HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(`[alert] Could not reach Telegram: ${String(err)}`);
    }
  }
}
