'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { openGiveawayPopup } from './giveaway-fab-popup';

/**
 * Homepage floating button (mockup `.fab`) — sits above the bottom nav on
 * the right. Opens the sorteos preview popup, not the WhatsApp channel modal
 * (that one stays only as the home page's automatic popup,
 * `whatsapp-channel-popup.tsx`). Portaled to `document.body` so
 * `position: fixed` isn't broken by page stacking rules.
 *
 * Styled as a "Golden Ticket" badge (gold circle, radiating glow, ticket
 * icon) per Jose's design reference, confirmed live 2026-11-25 — replaces
 * the earlier mascot-avatar bubble this same button used before.
 */
export function WaFab() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div className="wa-fab">
      <button
        type="button"
        className="wa-fab-btn gold-ticket"
        aria-label="Ver sorteos"
        onClick={openGiveawayPopup}
      >
        <span className="gold-ticket-glow" aria-hidden="true" />
        <span className="gold-ticket-ic" aria-hidden="true">
          🎫
        </span>
        <span className="gold-ticket-label">
          GOLDEN
          <br />
          TICKET <span className="gold-ticket-star">★</span>
        </span>
      </button>
    </div>,
    document.body,
  );
}
