/**
 * Meta Conversions API — the server-side half of the Pixel.
 *
 * One Purchase per paid storefront order, carrying the order's `event_id` so
 * Meta deduplicates it against the browser Pixel's Purchase on the order page.
 *
 * Personal data is hashed before it leaves, as Meta requires: SHA-256 over a
 * normalised form. The player ID goes as `external_id` — it is the one stable
 * identifier every customer has — and never in the clear. IP, user agent and
 * the Pixel's own cookies go unhashed; that is what they are for, and Meta
 * refuses hashed versions of them.
 */

import { createHash } from 'node:crypto';
import type { ConversionOrder, ConversionReporter, ReportOutcome } from '@levelup/engine';

export interface MetaCapiOptions {
  pixelId: string;
  accessToken: string;
  /** The storefront's origin, for `event_source_url`. */
  siteOrigin: string;
  /** From Events Manager → Test events. Set while verifying, then remove. */
  testEventCode?: string | undefined;
  graphVersion?: string;
  fetch?: typeof fetch;
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * A Mexican phone in the E.164 digits Meta hashes: `52` plus ten digits.
 *
 * Customers type WhatsApp numbers every way there is — with or without +52,
 * with the old mobile `1` after it, with spaces and dashes. Returns null for
 * anything that does not come out as a plausible number, rather than hashing
 * garbage that can never match.
 */
export function normaliseMxPhone(raw: string | null): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 13 && digits.startsWith('521')) digits = `52${digits.slice(3)}`;
  if (digits.length === 10) digits = `52${digits}`;
  return /^52\d{10}$/.test(digits) ? digits : null;
}

export function buildPurchaseEvent(order: ConversionOrder, siteOrigin: string) {
  const phone = normaliseMxPhone(order.contactWhatsapp);
  const email = order.contactEmail?.trim().toLowerCase() || null;

  return {
    event_name: 'Purchase',
    event_time: Math.floor(order.paidAt.getTime() / 1000),
    event_id: order.eventId,
    action_source: 'website',
    event_source_url: `${siteOrigin}/comprar/${encodeURIComponent(order.comboKey)}`,
    user_data: {
      external_id: [sha256(order.playerId)],
      country: [sha256('mx')],
      ...(phone ? { ph: [sha256(phone)] } : {}),
      ...(email ? { em: [sha256(email)] } : {}),
      ...(order.clientIp ? { client_ip_address: order.clientIp } : {}),
      client_user_agent: order.userAgent,
      ...(order.fbp ? { fbp: order.fbp } : {}),
      ...(order.fbc ? { fbc: order.fbc } : {}),
    },
    custom_data: {
      currency: 'MXN',
      value: order.priceMxnCents / 100,
      content_type: 'product',
      content_ids: [order.comboKey],
      num_items: 1,
      order_id: order.orderNumber,
    },
  };
}

export class MetaConversionsReporter implements ConversionReporter {
  readonly name = 'Meta CAPI';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MetaCapiOptions) {
    if (!/^\d{8,20}$/.test(options.pixelId)) throw new Error('META_PIXEL_ID must be the numeric pixel id');
    if (!options.accessToken) throw new Error('META_CAPI_ACCESS_TOKEN is required');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async reportPurchase(order: ConversionOrder): Promise<ReportOutcome> {
    const version = this.options.graphVersion ?? 'v23.0';
    const url = `https://graph.facebook.com/${version}/${this.options.pixelId}/events`;

    const body = {
      data: [buildPurchaseEvent(order, this.options.siteOrigin)],
      ...(this.options.testEventCode ? { test_event_code: this.options.testEventCode } : {}),
      access_token: this.options.accessToken,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { ok: false, retryable: true, message: `unreachable: ${String(err)}` };
    }

    if (response.ok) return { ok: true };

    const text = await response.text().catch(() => '');
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // Keep the raw text.
    }

    // 4xx other than rate limiting is a token, pixel or payload problem that
    // will fail identically next time.
    const retryable = response.status === 429 || response.status >= 500;
    return { ok: false, retryable, message: `${response.status}: ${message}` };
  }
}
