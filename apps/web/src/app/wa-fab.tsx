'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import presenta from '../assets/mascot/presenta.webp';
import { openWhatsappChannelPopup } from './whatsapp-channel-popup';

/**
 * Homepage floating avatar (mockup `.fab`) — sits above the bottom nav on the
 * right and opens the WhatsApp channel modal. Portaled to `document.body` so
 * `position: fixed` isn't broken by page stacking rules.
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
        className="wa-fab-btn"
        aria-label="Abrir canal de WhatsApp"
        onClick={openWhatsappChannelPopup}
      >
        <img src={presenta.src} alt="" width={38} height={38} decoding="async" />
        <span className="wa-fab-dot" aria-hidden="true" />
      </button>
    </div>,
    document.body,
  );
}
