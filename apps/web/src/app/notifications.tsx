'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { BellIcon } from './icons';
import { markNoticesRead } from './notification-actions';

export interface NoticeItem {
  id: string;
  title: string;
  summary: string;
  when: string;
  href: string;
  unread: boolean;
}

export function NotificationBell({
  signedIn,
  notices,
}: {
  signedIn: boolean;
  notices: NoticeItem[];
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(notices);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const unread = items.some((item) => item.unread);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && signedIn && items.some((item) => item.unread)) {
      await markNoticesRead();
      setItems((current) => current.map((item) => ({ ...item, unread: false })));
    }
  }

  return (
    <div className="hm-notif" ref={rootRef}>
      <button
        type="button"
        className="hm-bar-user"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={unread ? 'Avisos, hay novedades sin leer' : 'Avisos'}
        onClick={() => void toggle()}
      >
        <BellIcon className="icon" />
        {unread && <span className="hm-bar-bell-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div id={panelId} className="hm-notif-panel" role="dialog" aria-label="Avisos de tu cuenta">
          <p className="hm-notif-title">Avisos</p>
          {!signedIn && (
            <>
              <p className="hm-notif-empty">Inicia sesión para ver los avisos de tus recargas.</p>
              <Link href="/cuenta" className="hm-notif-login">
                Entrar a mi cuenta
              </Link>
            </>
          )}
          {signedIn && items.length === 0 && (
            <p className="hm-notif-empty">
              No hay avisos todavía. Cuando un pago o una entrega cambie, aparecerá aquí.
            </p>
          )}
          {signedIn && items.length > 0 && (
            <ul className="hm-notif-list">
              {items.map((item) => (
                <li key={item.id}>
                  <Link href={item.href}>
                    <strong>{item.title}</strong>
                    <span>{item.summary}</span>
                    <time>{item.when}</time>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
