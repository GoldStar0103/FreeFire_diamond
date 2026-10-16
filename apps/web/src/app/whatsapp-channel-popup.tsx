'use client';

import { useEffect, useState } from 'react';
import cardArt from '../assets/make/whatsapp-community.png';

const STORAGE_KEY = 'levelup_whatsapp_popup_hide_until';

/** "Hoy" means the Mexico City calendar day, not the visitor's own clock. */
function todayMexicoCity(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
}

/**
 * The site-wide "join our WhatsApp channel" popup the client asked for.
 * The card is the approved artwork; the buttons sit on the painted controls.
 * Shown once per Mexico City day per browser.
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
    <div className="wa-popup-overlay" onMouseDown={dismiss}>
      <section
        className="wa-popup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wa-popup-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="wa-popup-title" className="sr-only">
          ¡Únete a nuestra Comunidad!
        </h2>
        <img src={cardArt.src} alt="" />
        <button type="button" className="wa-popup-close" aria-label="Cerrar" onClick={dismiss} />
        <a
          className="wa-popup-join"
          href={channelUrl}
          target="_blank"
          rel="noreferrer"
          onClick={dismiss}
        >
          <span className="sr-only">Unirme al canal</span>
        </a>
        <button type="button" className="wa-popup-continue" onClick={dismiss}>
          <span className="sr-only">Continuar en la página</span>
        </button>
        <button type="button" className="wa-popup-hide" onClick={dismissForToday}>
          <span className="sr-only">No mostrar más por hoy</span>
        </button>
      </section>
    </div>
  );
}
