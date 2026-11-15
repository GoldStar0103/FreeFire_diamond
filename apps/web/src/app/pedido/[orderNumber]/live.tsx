'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { setPixelUserData, trackPixel } from '../../../lib/pixel';

/**
 * Re-render the page from the server every few seconds while something is
 * about to change — a card payment confirming, diamonds arriving. The customer
 * is sitting on this page with the game open in another app; making them
 * pull-to-refresh to find out is a small cruelty.
 */
export function AutoRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return null;
}

/**
 * The browser half of the Purchase event.
 *
 * Fired once per order per browser — a customer refreshing their order page
 * ten times is one purchase, not ten. Meta also deduplicates against the
 * worker's server-side event by `eventId`, so the order's own id is passed.
 *
 * This is a fresh page load (a full navigation from checkout, sometimes in a
 * new tab after a gateway redirect), so the Pixel SDK here has no memory of
 * whatever `setPixelUserData` calls checkout.tsx made on the previous page —
 * each page's `fbq`/`ttq` instance only knows what is `set` on it directly.
 * Without this, Purchase — the one event ad spend is actually optimised
 * against — carried no phone/player-id match data at all. `setPixelUserData`
 * must run before `trackPixel` below: Meta's SDK only attaches `userData` to
 * `track` calls made after the `set`, never retroactively to one already sent.
 */
export function PurchasePixel({
  orderNumber,
  eventId,
  value,
  comboKey,
  playerId,
  whatsapp,
}: {
  orderNumber: string;
  eventId: string;
  value: number;
  comboKey: string | null;
  playerId: string;
  whatsapp: string | null;
}) {
  useEffect(() => {
    const key = `lu:purchase:${orderNumber}`;
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, '1');
    } catch {
      // Private mode: fire anyway; the eventId still deduplicates server-side.
    }
    setPixelUserData({ playerId, ...(whatsapp ? { whatsapp } : {}) });
    trackPixel(
      'Purchase',
      {
        value,
        currency: 'MXN',
        content_type: 'product',
        ...(comboKey ? { content_ids: [comboKey] } : {}),
      },
      eventId,
    );
  }, [orderNumber, eventId, value, comboKey, playerId, whatsapp]);
  return null;
}
