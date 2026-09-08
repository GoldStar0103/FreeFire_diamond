import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOrderDetail } from '@levelup/db';
import { db } from '../../../../lib/db';
import { requireSession } from '../../../../lib/session';
import {
  dateTime,
  diamonds,
  itemStatusLabel,
  mxn,
  orderStatusLabel,
  resolutionLabel,
  statusTone,
  usd,
} from '../../../../lib/format';

export const dynamic = 'force-dynamic';

/**
 * How this call was settled, as one sentence.
 *
 * The wallet pair is the interesting part: when the provider timed out, the
 * before/after balance is the evidence the item was delivered rather than a
 * guess. Built as a string so the JSX stays flat and readable.
 */
const hasPayload = (item: { requestPayload: unknown; responsePayload: unknown }): boolean =>
  item.requestPayload != null || item.responsePayload != null;

function confirmationLine(item: {
  resolvedBy: string | null;
  walletBeforeUsd: string | null;
  walletAfterUsd: string | null;
  providerTransactionId: string | null;
  sentAt: Date | null;
}): string {
  const parts = [`Confirmado por ${resolutionLabel(item.resolvedBy)}`];

  if (item.walletBeforeUsd !== null && item.walletAfterUsd !== null) {
    parts.push(
      `saldo ${Number(item.walletBeforeUsd).toFixed(2)} → ${Number(item.walletAfterUsd).toFixed(2)} USD`,
    );
  }
  if (item.providerTransactionId !== null) {
    parts.push(`transacción ${item.providerTransactionId}`);
  }
  if (item.sentAt !== null) parts.push(dateTime(item.sentAt));

  return parts.join(' · ');
}

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  const order = await getOrderDetail(db, id);
  if (!order) notFound();

  const snapshot = order.comboSnapshot as { name?: string; advertisedDiamonds?: number };

  return (
    <>
      <div className="row" style={{ marginBottom: 4 }}>
        <Link href="/pedidos" style={{ color: 'var(--muted)', fontSize: 14 }}>
          ← Pedidos
        </Link>
      </div>

      <div className="row">
        <h1 className="mono" style={{ marginBottom: 0 }}>
          {order.orderNumber}
        </h1>
        <span className={`badge ${statusTone(order.status)}`}>
          {orderStatusLabel(order.status)}
        </span>
      </div>
      <p className="subtitle">
        {snapshot.name} · {mxn(order.priceMxnCents)}
      </p>

      <div className="card">
        <div className="row">
          <strong>
            {diamonds(order.progress.delivered)} de {diamonds(order.progress.total)} 💎 entregados
          </strong>
          <div className="spacer" />
          <span style={{ color: 'var(--muted)' }}>{order.progress.pct.toFixed(0)}%</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${order.progress.pct}%` }} />
        </div>
      </div>

      <h2>Cliente y pago</h2>
      <div className="card">
        <dl className="kv">
          <dt>ID de jugador</dt>
          <dd className="mono">{order.playerId}</dd>

          {order.playerNickname && (
            <>
              <dt>Nombre en el juego</dt>
              <dd>{order.playerNickname}</dd>
            </>
          )}

          {order.serverId && (
            <>
              <dt>Servidor</dt>
              <dd>{order.serverId}</dd>
            </>
          )}

          {order.contactWhatsapp && (
            <>
              <dt>WhatsApp</dt>
              <dd className="mono">{order.contactWhatsapp}</dd>
            </>
          )}

          <dt>Creado</dt>
          <dd>{dateTime(order.createdAt)}</dd>

          {order.payment && (
            <>
              <dt>Método</dt>
              <dd>{order.payment.method}</dd>

              <dt>Estado del pago</dt>
              <dd>
                <span className={`badge ${order.payment.status === 'paid' ? 'ok' : 'warn'}`}>
                  {order.payment.status}
                </span>
              </dd>

              <dt>Esperado / recibido</dt>
              <dd>
                {mxn(order.payment.amountExpectedCents)}
                {order.payment.amountReceivedCents !== null && (
                  <> / {mxn(order.payment.amountReceivedCents)}</>
                )}
              </dd>

              {order.payment.reference && (
                <>
                  <dt>Referencia</dt>
                  <dd className="mono">{order.payment.reference}</dd>
                </>
              )}

              <dt>Comprobante</dt>
              <dd>
                {order.payment.hasComprobante ? (
                  <a
                    href={`/api/comprobante/${order.payment.paymentId}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--accent)' }}
                  >
                    Abrir
                  </a>
                ) : (
                  <span style={{ color: 'var(--muted)' }}>Sin comprobante</span>
                )}
              </dd>
            </>
          )}

          {order.completedAt && (
            <>
              <dt>Completado</dt>
              <dd>{dateTime(order.completedAt)}</dd>
            </>
          )}
        </dl>
      </div>

      <h2>Recargas al proveedor ({order.items.length})</h2>
      <p className="subtitle">
        El cliente ve una sola compra. Aquí está cada llamada por separado, con lo que
        respondió el proveedor.
      </p>

      {order.items.map((item) => (
        <div className="card" key={item.itemId} style={{ marginBottom: 10 }}>
          <div className="row">
            <strong>#{item.sequence + 1}</strong>
            <span>{diamonds(item.diamondsBase)} 💎 base</span>
            <span className={`badge ${statusTone(item.status)}`}>
              {itemStatusLabel(item.status)}
            </span>
            {item.attemptCount > 1 && (
              <span className="badge muted">{item.attemptCount} intentos</span>
            )}
            {item.errorCode && <span className="badge warn">{item.errorCode}</span>}
            <div className="spacer" />
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>{usd(item.costUsd)}</span>
          </div>

          {/* The wallet pair is how an ambiguous call was settled. Showing it
              is what turns "trust us" into evidence. */}
          {item.resolvedBy !== null && (
            <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8 }}>
              {confirmationLine(item)}
            </div>
          )}

          {/* Explicit boolean: the payloads are `unknown`, and `a || b && <jsx/>`
              would widen the whole expression to unknown, which is not a ReactNode. */}
          {hasPayload(item) && (
            <details className="payload">
              <summary>Ver respuesta del proveedor</summary>
              <pre className="payload-body">
                {JSON.stringify(
                  { request: item.requestPayload, response: item.responsePayload },
                  null,
                  2,
                )}
              </pre>
            </details>
          )}
        </div>
      ))}

      <h2>Combo congelado</h2>
      <p className="subtitle">
        La receta y el precio quedaron guardados al crear el pedido, para que un cambio
        posterior en las promociones no lo afecte.
      </p>
      <details className="payload">
        <summary>Ver detalle</summary>
        <pre className="payload-body">{JSON.stringify(order.comboSnapshot, null, 2)}</pre>
      </details>
    </>
  );
}
