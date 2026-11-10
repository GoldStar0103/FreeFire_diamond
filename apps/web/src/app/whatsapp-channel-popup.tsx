'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MascotMedia } from './mascot-media';
import popupStill from '../assets/mascot/popup-still.webp';

const STORAGE_KEY = 'levelup_whatsapp_popup_hide_until';
/** Dispatched by the homepage FAB so the modal can reopen after a dismiss. */
export const WA_POPUP_OPEN_EVENT = 'levelup:wa-popup-open';

export function openWhatsappChannelPopup() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(WA_POPUP_OPEN_EVENT));
}

/** "Hoy" means the Mexico City calendar day, not the visitor's own clock. */
function todayMexicoCity(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
}

const TILES = [
  {
    label: 'Ofertas primero',
    path: (
      <>
        <path d="M4 9h16v10H4z" />
        <path d="M3 5.5h18v3.5H3z" />
        <path d="M12 9v10" />
      </>
    ),
  },
  {
    label: 'Aviso de reposición',
    path: (
      <>
        <path d="M20 11a8 8 0 1 0-2.6 5.9" />
        <path d="M20 5v6h-6" />
      </>
    ),
  },
  {
    label: 'Novedades',
    path: <path d="M13 2 5 14h5l-1 8 9-12h-5z" />,
  },
];

/**
 * The site-wide "join our WhatsApp channel" popup the client asked for,
 * replacing a manual snippet+CSS hack they had on the old site. Shown once
 * per Mexico City day per browser — `localStorage`, not a cookie, since
 * nothing here needs the server to know about it.
 *
 * Portaled to `document.body` so it stays a true viewport-fixed overlay
 * (same as the approved redesign mockup), not a block that lands in the
 * page flow above the footer when body stacking rules fight `position:fixed`.
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
    const open = () => setVisible(true);
    window.addEventListener(WA_POPUP_OPEN_EVENT, open);

    // Auto-show once per day — skipped when the visitor already dismissed
    // for today. The FAB can still reopen it via WA_POPUP_OPEN_EVENT.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (hideUntil !== todayMexicoCity()) {
      // A beat after the page settles, not on first paint — a modal fighting
      // the page for attention before anyone has seen what store this even is
      // reads as spam, not a welcome.
      timer = setTimeout(open, 1200);
    }
    return () => {
      window.removeEventListener(WA_POPUP_OPEN_EVENT, open);
      if (timer) clearTimeout(timer);
    };
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
  const dismissForToday = () => {
    try {
      localStorage.setItem(STORAGE_KEY, todayMexicoCity());
    } catch {
      /* No storage to persist to — it just shows again next time. */
    }
    setVisible(false);
  };

  return createPortal(
    <div className="wa-overlay" role="dialog" aria-modal="true" aria-labelledby="wa-popup-title">
      <div className="wa-sheet">
        <button type="button" className="wa-close" aria-label="Cerrar" onClick={dismiss}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <div className="wa-top">
          <span className="hex" aria-hidden="true" />
          <span className="wa-shapes" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="wa-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.4A10 10 0 1 0 12 2zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-2.9.8.8-2.8-.2-.3A8 8 0 1 1 12 20z" />
            </svg>
          </span>
          <span className="wa-bubble">
            Aquí te aviso
            <br />
            primero de todo
          </span>
          <MascotMedia
            className="wa-fighter"
            webm="/mascot/mascota-popup.webm"
            animWebp="/mascot/mascota-popup-anim.webp"
            stillSrc={popupStill.src}
            alt="Luchador de LevelUp con audífonos abriendo los brazos"
          />
          <span className="glowline" aria-hidden="true" />
        </div>

        <div className="wa-body">
          <div className="wa-head">
            <b id="wa-popup-title">
              Únete a nuestro <i>canal</i>
            </b>
            <p>
              Ahí publicamos las ofertas, los productos que vuelven a estar disponibles y las
              novedades antes que en la página. Solo publica la tienda, así que no recibirás
              mensajes de otras personas.
            </p>
          </div>

          <div className="wa-tiles">
            {TILES.map((tile) => (
              <div key={tile.label} className="wa-tile">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
                  {tile.path}
                </svg>
                <span>{tile.label}</span>
              </div>
            ))}
          </div>

          <div className="wa-actions">
            <a href={channelUrl} target="_blank" rel="noreferrer" className="btn btn-wa btn-block" onClick={dismiss}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                <path d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.4A10 10 0 1 0 12 2z" />
              </svg>
              Unirme al canal
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                <path d="M5 12h13M12 5l7 7-7 7" />
              </svg>
            </a>
            <button type="button" className="btn btn-ghost btn-block" onClick={dismiss}>
              Seguir en la página
            </button>
            <button type="button" className="wa-skip" onClick={dismissForToday}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true" width="14" height="14">
                <path d="M3 3l18 18" />
                <path d="M10.6 5.1A9 9 0 0 1 21 12c-.5 1.3-1.2 2.4-2 3.4" />
                <path d="M6.3 6.5A9 9 0 0 0 3 12c1.7 4.2 5 6 9 6 1.4 0 2.7-.3 3.9-.8" />
              </svg>
              No mostrar más por hoy
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
