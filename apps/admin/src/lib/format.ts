/**
 * Display formatting. Never arithmetic — money maths belongs in @levelup/shared.
 */

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const NUM = new Intl.NumberFormat('es-MX');

export const mxn = (centavos: number): string => MXN.format(centavos / 100);
export const diamonds = (value: number): string => NUM.format(value);

export const usd = (value: string | null): string =>
  value === null ? '—' : `$${Number(value).toFixed(2)} USD`;

export function dateTime(value: Date | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

/** "hace 12 min" — how long a customer has been waiting. */
export function relativeTime(value: Date | null): string {
  if (!value) return '—';
  const seconds = Math.floor((Date.now() - value.getTime()) / 1000);
  if (seconds < 60) return 'hace un momento';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

/** Spanish labels — the client reads these, not the enum values. */
const ORDER_STATUS_LABELS: Record<string, string> = {
  pending_payment: 'Esperando pago',
  payment_confirmed: 'Pago confirmado',
  processing: 'Procesando',
  partially_delivered: 'Entrega parcial',
  completed: 'Completado',
  payment_expired: 'Pago vencido',
  needs_review: 'Requiere revisión',
  refund_required: 'Requiere reembolso',
  cancelled: 'Cancelado',
};

const ITEM_STATUS_LABELS: Record<string, string> = {
  queued: 'En cola',
  sending: 'Enviando',
  succeeded: 'Entregado',
  failed: 'Falló',
  unknown: 'Sin confirmar',
  provider_pending: 'Pendiente en proveedor',
};

const RESOLUTION_LABELS: Record<string, string> = {
  response: 'respuesta del proveedor',
  wallet_delta: 'comparación de saldo',
  polling: 'consulta de estado',
  manual: 'decisión manual',
};

export const orderStatusLabel = (s: string): string => ORDER_STATUS_LABELS[s] ?? s;
export const itemStatusLabel = (s: string): string => ITEM_STATUS_LABELS[s] ?? s;
export const resolutionLabel = (s: string | null): string =>
  s === null ? '—' : (RESOLUTION_LABELS[s] ?? s);

/** Maps a status to a CSS class in globals.css. */
export function statusTone(status: string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (status === 'completed' || status === 'succeeded') return 'ok';
  if (status === 'needs_review' || status === 'refund_required' || status === 'unknown') return 'bad';
  if (status === 'failed' || status === 'partially_delivered' || status === 'payment_expired') {
    return 'warn';
  }
  if (status === 'cancelled') return 'muted';
  return 'warn';
}
