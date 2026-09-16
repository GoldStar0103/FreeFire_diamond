'use client';

import { useEffect, useState } from 'react';
import { ChatIcon } from './icons';

const STORAGE_KEY = 'levelup_whatsapp_popup_hide_until';

/** "Hoy" means the Mexico City calendar day, not the visitor's own clock. */
function todayMexicoCity(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
}

/**
 * The site-wide "join our WhatsApp channel" popup the client asked for,
 * replacing a manual snippet+CSS hack they had on the old site. Shown once
 * per Mexico City day per browser — `localStorage`, not a cookie, since
 * nothing here needs the server to know about it.
 */
export function WhatsappChannelPopup({ channelUrl }: { channelUrl: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let hideUntil: string | null = null;
    try {
      hideUntil = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* Private browsing or blocked storage — fall through and show it. */
    }
    if (hideUntil === todayMexicoCity()) return;

    // A beat after the page settles, not on first paint — a modal fighting
    // the page for attention before anyone has seen what store this even is
    // reads as spam, not a welcome.
    const timer = setTimeout(() => setVisible(true), 1200);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  const dismiss = () => setVisible(false);
  const dismissForToday = () => {
    try {
      localStorage.setItem(STORAGE_KEY, todayMexicoCity());
    } catch {
      /* No storage to persist to — it just shows again next time. */
    }
    setVisible(false);
  };

  return (
    <div className="wa-popup-overlay" role="dialog" aria-modal="true" aria-labelledby="wa-popup-title">
      <div className="wa-popup card">
        <button type="button" className="wa-popup-close" aria-label="Cerrar" onClick={dismiss}>
          ✕
        </button>
        <div className="wa-popup-icon">
          <ChatIcon className="icon" />
        </div>
        <h2 id="wa-popup-title" className="wa-popup-title">
          ¡Únete a nuestra Comunidad!
        </h2>
        <p className="wa-popup-text">
          Recibe promociones exclusivas, sorteos y soporte directo en nuestro canal oficial de
          WhatsApp.
        </p>
        <a href={channelUrl} target="_blank" rel="noreferrer" className="btn wide wa-popup-cta" onClick={dismiss}>
          <ChatIcon className="icon" /> Unirme al canal
        </a>
        <button type="button" className="btn ghost wide" onClick={dismiss}>
          Continuar en la página
        </button>
        <button type="button" className="wa-popup-hide-link" onClick={dismissForToday}>
          No mostrar más por hoy
        </button>
      </div>
    </div>
  );
}
