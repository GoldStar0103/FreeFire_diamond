'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { trackPixel } from '../../../lib/pixel';

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
 */
export function PurchasePixel({
  orderNumber,
  eventId,
  value,
  comboKey,
}: {
  orderNumber: string;
  eventId: string;
  value: number;
  comboKey: string | null;
}) {
  useEffect(() => {
    const key = `lu:purchase:${orderNumber}`;
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, '1');
    } catch {
      // Private mode: fire anyway; the eventId still deduplicates server-side.
    }
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
  }, [orderNumber, eventId, value, comboKey]);
  return null;
}
