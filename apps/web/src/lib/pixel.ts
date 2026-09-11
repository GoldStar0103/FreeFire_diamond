/**
 * Browser-side ad pixel events: Meta, and TikTok alongside it.
 *
 * A no-op whenever a pixel is not loaded — not configured, blocked by the
 * browser, or still loading. Tracking must never be able to break a checkout,
 * so nothing here throws and nothing waits on it.
 *
 * Callers speak Meta's vocabulary, because that is what the checkout was
 * written against; TikTok's equivalents are derived here, in one place, so the
 * two can never drift into reporting different things about the same click.
 */

type Fbq = (command: 'track' | 'trackCustom', event: string, params?: object, options?: object) => void;

/**
 * The part of TikTok's `ttq` the storefront uses. Before the SDK arrives, the
 * base code's stub queues these calls and replays them once it loads.
 */
interface Ttq {
  page: () => void;
  track: (event: string, params?: object, options?: object) => void;
}

declare global {
  interface Window {
    fbq?: Fbq;
    ttq?: Ttq;
  }
}

export type PixelEvent = 'ViewContent' | 'InitiateCheckout' | 'AddPaymentInfo' | 'Purchase';

export interface PixelParams {
  value?: number;
  currency?: 'MXN';
  content_ids?: string[];
  content_name?: string;
  content_type?: 'product';
}

/**
 * TikTok's standard events. They match Meta's names except for the paid
 * purchase, which TikTok reports as `CompletePayment`.
 */
export type TikTokEvent = 'ViewContent' | 'InitiateCheckout' | 'AddPaymentInfo' | 'CompletePayment';

const TIKTOK_EVENTS: Record<PixelEvent, TikTokEvent> = {
  ViewContent: 'ViewContent',
  InitiateCheckout: 'InitiateCheckout',
  AddPaymentInfo: 'AddPaymentInfo',
  Purchase: 'CompletePayment',
};

export interface TikTokContent {
  content_id: string;
  content_type: 'product';
  content_name?: string;
  quantity: number;
  price?: number;
}

export interface TikTokParams {
  value?: number;
  currency?: 'MXN';
  content_type?: 'product';
  contents?: TikTokContent[];
}

export type TikTokCall = [event: TikTokEvent, params: TikTokParams, options?: { event_id: string }];

/**
 * Meta's event and parameters, in TikTok's shape.
 *
 * TikTok wants the products as a `contents` array rather than a list of ids.
 * Every storefront order is one combo, so the one entry carries the price too;
 * with several ids there is no honest per-item price to give, so it is left
 * out rather than guessed.
 */
export function tiktokEvent(event: PixelEvent, params: PixelParams = {}, eventId?: string): TikTokCall {
  const ids = params.content_ids ?? [];
  const single = ids.length === 1;

  const out: TikTokParams = {};
  if (params.value !== undefined) out.value = params.value;
  if (params.currency) out.currency = params.currency;
  if (ids.length > 0) {
    out.content_type = 'product';
    out.contents = ids.map((id) => ({
      content_id: id,
      content_type: 'product' as const,
      ...(single && params.content_name ? { content_name: params.content_name } : {}),
      quantity: 1,
      ...(single && params.value !== undefined ? { price: params.value } : {}),
    }));
  }

  // The same id Meta gets: once TikTok's server-side Events API is wired, it
  // is what lets TikTok count the browser and server reports as one purchase.
  return eventId ? [TIKTOK_EVENTS[event], out, { event_id: eventId }] : [TIKTOK_EVENTS[event], out];
}

/**
 * `eventId` must be the order's own `event_id` for Purchase. The worker sends
 * the same purchase server-side with that id, and Meta counts the pair once.
 *
 * Each pixel gets its own try: an exception inside one vendor's script must
 * not cost the other its event.
 */
export function trackPixel(event: PixelEvent, params: PixelParams = {}, eventId?: string): void {
  try {
    window.fbq?.('track', event, params, eventId ? { eventID: eventId } : undefined);
  } catch {
    // Deliberately silent — see above.
  }
  try {
    const ttq = window.ttq;
    if (ttq) ttq.track(...tiktokEvent(event, params, eventId));
  } catch {
    // Likewise.
  }
}
