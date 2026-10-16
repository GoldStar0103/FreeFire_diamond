import 'server-only';
import { cookies } from 'next/headers';
import { listMyOrders } from '@levelup/db';
import { getDb } from './server';

export const NOTICE_SEEN_COOKIE = 'levelup_notif_seen';

export interface AccountNotice {
  id: string;
  title: string;
  summary: string;
  when: string;
  href: string;
  unread: boolean;
}

const COPY: Record<string, { title: string; summary: (name: string) => string }> = {
  pending_payment: {
    title: 'Pago pendiente',
    summary: (name) => `${name}. El pedido sigue esperando el pago y todavía no está entregado.`,
  },
  payment_confirmed: {
    title: 'Pago recibido',
    summary: (name) => `${name}. El pago se confirmó. La recarga sigue en proceso.`,
  },
  processing: {
    title: 'Recarga en proceso',
    summary: (name) => `${name}. Estamos enviando la recarga.`,
  },
  partially_delivered: {
    title: 'Entrega parcial',
    summary: (name) => `${name}. Parte de la recarga ya se envió.`,
  },
  completed: {
    title: 'Recarga completada',
    summary: (name) => `${name}. La entrega quedó confirmada.`,
  },
  payment_expired: {
    title: 'Pago vencido',
    summary: (name) => `${name}. El pago no se completó a tiempo.`,
  },
  needs_review: {
    title: 'Pedido en revisión',
    summary: (name) => `${name}. Estamos revisando este pedido antes de continuar.`,
  },
  refund_required: {
    title: 'Pedido en revisión',
    summary: (name) => `${name}. Este pedido necesita una revisión.`,
  },
  cancelled: {
    title: 'Pedido cancelado',
    summary: (name) => `${name}. Este pedido se canceló y no se entregó.`,
  },
  refunded: {
    title: 'Pedido reembolsado',
    summary: (name) => `${name}. Este pedido fue reembolsado.`,
  },
};

const WHEN = new Intl.DateTimeFormat('es-MX', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Mexico_City',
});

function seenAt(raw: string | undefined, profileId: string): number {
  if (!raw) return 0;
  const [owner, ts] = raw.split('|');
  if (owner !== profileId) return 0;
  const n = Number(ts);
  return Number.isFinite(n) ? n : 0;
}

/** Recent orders for the signed-in player. No prices, no other accounts. */
export async function loadAccountNotices(profileId: string, playerId: string): Promise<AccountNotice[]> {
  const rows = await listMyOrders(getDb(), playerId, 8, profileId);
  const store = await cookies();
  const cutoff = seenAt(store.get(NOTICE_SEEN_COOKIE)?.value, profileId);

  return rows.map((row) => {
    const copy = COPY[row.status] ?? {
      title: 'Actualización de pedido',
      summary: (name: string) => `${name}. Revisa el estado del pedido.`,
    };
    return {
      id: row.orderNumber,
      title: copy.title,
      summary: copy.summary(row.comboName),
      when: WHEN.format(row.createdAt),
      href: `/pedido/${row.orderNumber}`,
      unread: row.createdAt.getTime() > cutoff,
    };
  });
}
