'use client';

/**
 * The site header's bell — polled, not pushed (no realtime infra exists
 * anywhere in this app; see the new-features plan). Only rendered for a
 * signed-in session; logged-out visitors keep the static decorative bell in
 * `site-header.tsx`, since there is nothing to show them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { BellIcon } from './icons';

const POLL_MS = 25_000;

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  targetUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

function timeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

async function postRead(body: { ids?: string[]; all?: boolean }): Promise<void> {
  await fetch('/api/notifications/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { unreadCount: number; items: NotificationItem[] };
      setUnreadCount(data.unreadCount);
      setItems(data.items);
    } catch {
      // A failed background poll isn't worth surfacing — the next one retries.
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const markAllRead = async () => {
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    setUnreadCount(0);
    await postRead({ all: true });
  };

  const openNotification = (n: NotificationItem) => {
    if (!n.readAt) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      setUnreadCount((c) => Math.max(0, c - 1));
      void postRead({ ids: [n.id] });
    }
    setOpen(false);
  };

  return (
    <div className="nt-wrap" ref={wrapRef}>
      <button
        type="button"
        className="hm-bar-user hm-bar-bell"
        aria-label="Notificaciones"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <BellIcon className="icon" />
        {unreadCount > 0 && <span className="hm-bar-bell-dot">{unreadCount > 9 ? '9+' : unreadCount}</span>}
      </button>
      {open && (
        <div className="nt-panel" role="menu">
          <div className="nt-panel-head">
            <b>Notificaciones</b>
            {unreadCount > 0 && (
              <button type="button" className="nt-markall" onClick={markAllRead}>
                Marcar todas como leídas
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="nt-empty">Sin notificaciones por ahora.</p>
          ) : (
            <ul className="nt-list">
              {items.map((n) => (
                <li key={n.id} className={n.readAt ? 'nt-item' : 'nt-item is-unread'}>
                  {n.targetUrl ? (
                    <Link href={n.targetUrl} onClick={() => openNotification(n)}>
                      <b>{n.title}</b>
                      <span>{n.message}</span>
                      <em>{timeAgo(n.createdAt)}</em>
                    </Link>
                  ) : (
                    <button type="button" onClick={() => openNotification(n)}>
                      <b>{n.title}</b>
                      <span>{n.message}</span>
                      <em>{timeAgo(n.createdAt)}</em>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
