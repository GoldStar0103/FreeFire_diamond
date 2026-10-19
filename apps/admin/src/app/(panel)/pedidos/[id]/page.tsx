import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOrderDetail, getOrderLpSummary } from '@levelup/db';
import { getDb } from '../../../../lib/db';
import { requireSession } from '../../../../lib/session';
import { orderWhatsappMessage, waUrl } from '../../../../lib/whatsapp';
import { ReviewPanel } from './review-panel';
import { ReleasePaymentButton } from './release-payment-button';
import { CheckMercadoPagoButton, CheckMercadoPagoReferenceForm } from './check-mercadopago-button';
import { ReverseOrderForm } from './reverse-order-form';
import { LpOverrideForm } from './lp-override-form';
import {
  dateTime,
  diamonds,
  itemStatusLabel,
  methodLabel,
  mxn,
  orderStatusLabel,
  resolutionLabel,
  statusTone,
  usd,
} from '../../../../lib/format';

export const dynamic = 'force-dynamic';

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pending: 'Pendiente',
  under_review: 'En revisión',
  paid: 'Pagado',
  expired: 'Vencido',
  failed: 'Rechazado',
  amount_mismatch: 'Monto no coincide',
};

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
  status: string;
  resolvedBy: string | null;
  walletBeforeUsd: string | null;
  walletAfterUsd: string | null;
  providerTransactionId: string | null;
  sentAt: Date | null;
}): string {
  // An `unknown` item carries `wallet_delta` because the comparison was
  // attempted — and failed to settle it. "Confirmado" would say the opposite.
  const parts = [
    item.status === 'unknown'
      ? `Sin confirmar tras ${resolutionLabel(item.resolvedBy)}`
      : `Confirmado por ${resolutionLabel(item.resolvedBy)}`,
  ];

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

  const db = getDb();
  const [order, lp] = await Promise.all([getOrderDetail(db, id), getOrderLpSummary(db, id)]);
  if (!order) notFound();

  const snapshot = order.comboSnapshot as { name?: string; advertisedDiamonds?: number };
  const chatUrl = waUrl(
    order.contactWhatsapp,
    orderWhatsappMessage(
      { orderNumber: order.orderNumber, comboName: snapshot.name, advertisedDiamonds: snapshot.advertisedDiamonds },
      'general',
    ),
  );

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

      {/* Renders only for an order waiting on a human (review or refund). */}
      <ReviewPanel
        orderId={order.orderId}
        orderStatus={order.status}
        items={order.items.map((item) => ({
          itemId: item.itemId,
          sequence: item.sequence,
          status: item.status,
          diamondsBase: diamonds(item.diamondsBase),
          costUsd: usd(item.costUsd),
          sentAt: item.sentAt ? dateTime(item.sentAt) : null,
          walletLine:
            item.walletBeforeUsd !== null && item.walletAfterUsd !== null
              ? `Saldo antes ${Number(item.walletBeforeUsd).toFixed(2)} → después ${Number(item.walletAfterUsd).toFixed(2)} USD`
              : item.walletBeforeUsd !== null
                ? `Saldo antes de enviarla: ${Number(item.walletBeforeUsd).toFixed(2)} USD`
                : null,
        }))}
      />

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
              <dd className="mono">
                {order.contactWhatsapp}
                {chatUrl && (
                  <a
                    className="btn sm"
                    href={chatUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ marginLeft: 10 }}
                  >
                    💬 Escribirle
                  </a>
                )}
              </dd>
            </>
          )}

          <dt>Creado</dt>
          <dd>{dateTime(order.createdAt)}</dd>

          {order.payment && (
            <>
              <dt>Método</dt>
              <dd>{methodLabel(order.payment.method, order.payment.gateway)}</dd>

              <dt>Estado del pago</dt>
              <dd>
                <span className={`badge ${order.payment.status === 'paid' ? 'ok' : 'warn'}`}>
                  {PAYMENT_STATUS_LABEL[order.payment.status] ?? order.payment.status}
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
                  <dd className="mono">
                    {/* A Stripe PaymentIntent opens straight onto the charge,
                        which is where a dispute or refund gets handled. */}
                    {order.payment.reference.startsWith('pi_') ? (
                      <a
                        href={`https://dashboard.stripe.com/payments/${encodeURIComponent(order.payment.reference)}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: 'var(--accent)' }}
                      >
                        {order.payment.reference} ↗
                      </a>
                    ) : (
                      order.payment.reference
                    )}
                  </dd>
                </>
              )}

              {/* No Stripe-settled payment — card, OXXO, or SPEI — has a
                  receipt photo; Stripe is the receipt for all three. This
                  used to only exclude 'card', back when every Stripe order
                  was recorded that way regardless of which method actually
                  settled it; once OXXO/SPEI started recording their real
                  method, this line started showing "Sin comprobante" on a
                  legitimately-paid OXXO/SPEI order, reading as something
                  missing when there was never anything to upload. */}
              {order.payment.method !== 'card' &&
                order.payment.method !== 'oxxo' &&
                order.payment.method !== 'spei' && (
                <>
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

      {/* Only for a gateway payment (SPEI/OXXO) still awaiting its own
          confirmation — manual transfers already have their release
          mechanism (approving the comprobante in Aprobaciones), and card
          settles itself in seconds. */}
      {order.status === 'pending_payment' &&
        (order.payment?.method === 'spei' || order.payment?.method === 'oxxo') && (
          <ReleasePaymentButton orderId={order.orderId} orderNumber={order.orderNumber} />
        )}

      {/* Mercado Pago only — Stripe's own dashboard link above already covers
          card, and manual transfers have no gateway to ask. */}
      {order.payment?.gateway === 'mercadopago' && (
        <CheckMercadoPagoButton orderNumber={order.orderNumber} />
      )}

      {/* Not gated to this order's own gateway: a customer disputing a
          manual-transfer or Stripe order can still wave around a real
          Mercado Pago reference that actually belongs to a different
          order — this is how that gets caught. */}
      <CheckMercadoPagoReferenceForm currentOrderNumber={order.orderNumber} />

      {/* Only for an order that actually earned Level Pass progress, and not
          one already reversed — its LP is gone and editing it would put
          progress back on a purchase that no longer stands. */}
      {lp && lp.reversedAt === null && (
        <LpOverrideForm
          orderId={order.orderId}
          calculatedLp={lp.calculatedLp}
          awardedLp={lp.awardedLp}
          overridden={lp.overridden}
          overrideReason={lp.overrideReason}
        />
      )}

      {/* The only action available on a delivered order, and the only way out
          of `completed` in the state machine. */}
      {order.status === 'completed' && <ReverseOrderForm orderId={order.orderId} />}

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
