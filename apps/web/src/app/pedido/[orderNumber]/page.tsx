import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { findCustomerOrder, type CustomerOrderStatus } from '@levelup/db';
import { getDb } from '../../../lib/server';
import { diamonds, mxn } from '../../../lib/format';
import { vipGroupUrl } from '../../../lib/vip';

export const dynamic = 'force-dynamic';

/**
 * Never indexed. The URL carries a Free Fire player ID and the page shows what
 * they bought and what they paid — indexed, that is a searchable record of
 * someone's purchases tied to their game account.
 *
 * next.config.mjs already sends `X-Robots-Tag: noindex` for this path and
 * robots.txt disallows it. This is the third layer, and the cheapest.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

const STATUS: Record<CustomerOrderStatus, { label: string; detail: string; tone: string }> = {
  esperando_pago: {
    label: 'Esperando tu pago',
    detail: 'Sube tu comprobante para que podamos continuar.',
    tone: 'warn',
  },
  pago_en_revision: {
    label: 'Revisando tu pago',
    detail: 'Ya recibimos tu comprobante. En cuanto lo validemos entra tu recarga.',
    tone: 'warn',
  },
  procesando: {
    label: 'Recargando tus diamantes',
    detail: 'Tu pago quedó confirmado. Los diamantes están entrando a tu cuenta.',
    tone: 'ok',
  },
  completado: {
    label: '¡Listo! Diamantes entregados',
    detail: 'Revisa tu cuenta de Free Fire. ¡Gracias por tu compra!',
    tone: 'ok',
  },
  con_problema: {
    label: 'Estamos revisando tu pedido',
    detail: 'Algo no salió como esperábamos. Ya lo estamos atendiendo personalmente.',
    tone: 'bad',
  },
  cancelado: { label: 'Pedido cancelado', detail: 'Este pedido ya no está activo.', tone: 'muted' },
};

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderNumber: string }>;
  searchParams: Promise<{ id?: string }>;
}) {
  const { orderNumber } = await params;
  const { id } = await searchParams;

  // No accounts: the order number plus the player ID is the whole
  // authorisation model, so both must be present.
  if (!id) notFound();

  const order = await findCustomerOrder(getDb(), orderNumber, id);
  if (!order) notFound();

  const status = STATUS[order.status];
  const pct =
    order.advertisedDiamonds === 0
      ? 0
      : Math.min(100, (order.deliveredDiamonds / order.advertisedDiamonds) * 100);

  const supportUrl = `https://wa.me/${process.env.WHATSAPP_SUPPORT_NUMBER ?? ''}?text=${encodeURIComponent(
    `Hola, tengo un problema con mi pedido ${order.orderNumber} (ID ${order.playerId}).`,
  )}`;

  // Only once the diamonds are actually in their account. Inviting someone to
  // the VIP group while their order is still processing would read as a sales
  // pitch at the exact moment they are waiting to find out if we delivered.
  const vipUrl = order.status === 'completado' ? vipGroupUrl() : null;

  return (
    <main className="page narrow">
      <div className={`card status-card ${status.tone}`}>
        <div className="status-label">{status.label}</div>
        <p className="status-detail">{status.detail}</p>

        {order.status === 'procesando' && (
          <>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="hint">
              {diamonds(order.deliveredDiamonds)} de {diamonds(order.advertisedDiamonds)} 💎
            </div>
          </>
        )}
      </div>

      <div className="card">
        <dl className="kv">
          <dt>Pedido</dt>
          <dd className="mono">{order.orderNumber}</dd>
          <dt>Paquete</dt>
          <dd>{order.comboName}</dd>
          <dt>Diamantes</dt>
          <dd>{diamonds(order.advertisedDiamonds)} 💎</dd>
          <dt>Cuenta</dt>
          <dd>
            {order.playerNickname ?? '—'}
            <div className="hint mono">ID {order.playerId}</div>
          </dd>
          <dt>Total</dt>
          <dd>{mxn(order.priceMxnCents)}</dd>
        </dl>
      </div>

      {/* Support appears only when an order actually needs a human. The client
          does not want a floating WhatsApp button in a market full of curious
          children — this is the one place it shows up. */}
      {order.needsSupport && (
        <a className="btn primary wide" href={supportUrl} target="_blank" rel="noreferrer">
          Escríbenos por WhatsApp
        </a>
      )}

      {vipUrl && (
        <div className="card vip">
          <div className="vip-title">🎁 Únete al grupo VIP</div>
          <p className="vip-text">
            Promos exclusivas, sorteos y los combos nuevos antes que nadie. Solo para clientes
            que ya compraron.
          </p>
          <a className="btn primary wide" href={vipUrl} target="_blank" rel="noreferrer">
            Entrar al grupo VIP
          </a>
        </div>
      )}

      <p className="hint center">
        Guarda este enlace para volver a consultar tu pedido.
      </p>
      <Link href="/" className="back center">
        ← Volver a la tienda
      </Link>
    </main>
  );
}
