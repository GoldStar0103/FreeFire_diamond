'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { GiftIcon } from './icons';

export const GIVEAWAY_POPUP_OPEN_EVENT = 'levelup:giveaway-popup-open';

/** Dispatched by the homepage floating bubble — see wa-fab.tsx. */
export function openGiveawayPopup() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(GIVEAWAY_POPUP_OPEN_EVENT));
}

export interface GiveawayPreview {
  id: string;
  title: string;
  prizeDescription: string;
  /** ISO string — plain Date props are fine across the RSC boundary, but a
   * string keeps the time math entirely on the client, in the viewer's own
   * clock tick. */
  closesAt: string;
}

function timeRemaining(closesAtIso: string): string {
  const ms = new Date(closesAtIso).getTime() - Date.now();
  if (ms <= 0) return 'Cerrando…';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min restantes`;
  if (hours < 24) return `${hours} h restantes`;
  return `${Math.floor(hours / 24)} día${Math.floor(hours / 24) === 1 ? '' : 's'} restantes`;
}

/**
 * The bubble's own popup (distinct from `whatsapp-channel-popup.tsx`'s
 * automatic home-page modal, which Jose asked to leave untouched). Previews
 * open sorteos and sends the visitor to the full `/sorteos` page.
 */
export function GiveawayFabPopup({ giveaways }: { giveaways: GiveawayPreview[] }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const open = () => setVisible(true);
    window.addEventListener(GIVEAWAY_POPUP_OPEN_EVENT, open);
    return () => window.removeEventListener(GIVEAWAY_POPUP_OPEN_EVENT, open);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [visible]);

  if (!visible) return null;

  const dismiss = () => setVisible(false);
  const preview = giveaways.slice(0, 3);

  return createPortal(
    <div className="gw-overlay" role="dialog" aria-modal="true" aria-labelledby="gw-popup-title">
      <div className="gw-sheet">
        <button type="button" className="wa-close" aria-label="Cerrar" onClick={dismiss}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <div className="gw-head">
          <span className="gw-ic" aria-hidden="true">
            <GiftIcon className="icon" />
          </span>
          <b id="gw-popup-title">Sorteos abiertos</b>
          <p>Participa con tus Golden Tickets — los ganas automáticamente con cada recarga.</p>
        </div>

        {preview.length > 0 && (
          <div className="gw-list">
            {preview.map((g) => (
              <Link key={g.id} href={`/sorteos/${g.id}`} className="gw-item" onClick={dismiss}>
                <span className="gw-item-title">{g.title}</span>
                <span className="gw-item-prize">{g.prizeDescription}</span>
                <span className="gw-item-time">{timeRemaining(g.closesAt)}</span>
              </Link>
            ))}
          </div>
        )}

        <div className="gw-actions">
          <Link href="/sorteos" className="btn primary wide" onClick={dismiss}>
            Ver todos los sorteos
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}
