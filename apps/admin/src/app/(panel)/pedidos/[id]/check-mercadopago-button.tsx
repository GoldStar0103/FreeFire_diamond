'use client';

import { useActionState, useState } from 'react';
import {
  checkMercadoPagoPayment,
  checkMercadoPagoReference,
  relinkMercadoPagoPayment,
  type MpCheckState,
  type MpReferenceCheckState,
  type RelinkState,
} from './actions';
import { dateTime, mxn } from '../../../../lib/format';

interface Props {
  orderNumber: string;
  /** 'mercadopago' (Checkout Pro) or 'mercadopago-embedded' (card/SPEI, Orders API). */
  gatewayName: string;
  /** Required for 'mercadopago-embedded' — its `getCharge` looks up by this, not the order number. */
  gatewayChargeId: string | null;
}

const STATE_LABEL: Record<string, string> = {
  pending: 'Pendiente',
  paid: 'Pagado',
  expired: 'Vencido',
  failed: 'Rechazado',
  refunded: 'Reembolsado',
};

/**
 * Only rendered by the order-detail page for a Mercado Pago payment — see
 * that page's own condition. Read-only: this asks Mercado Pago directly what
 * it has on file, it never changes anything here. See `checkMercadoPagoPayment`
 * for why (dispute resolution — "the customer says they paid").
 */
export function CheckMercadoPagoButton({ orderNumber, gatewayName, gatewayChargeId }: Props) {
  const [state, action, pending] = useActionState<MpCheckState, FormData>(checkMercadoPagoPayment, {
    status: 'idle',
  });

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Verificar con Mercado Pago</h2>
      <p className="subtitle">
        Pregunta directamente a Mercado Pago qué tiene registrado para este pedido — útil cuando el
        cliente dice que sí pagó y quieres confirmarlo con el proveedor de pago antes de decidir.
      </p>

      {state.status === 'error' && <div className="alert bad">{state.message}</div>}
      {state.status === 'not_found' && <div className="alert bad">{state.message}</div>}

      {state.status === 'ok' && state.snapshot && (
        <dl className="kv">
          <dt>Estado en Mercado Pago</dt>
          <dd>
            <span className={`badge ${state.snapshot.state === 'paid' ? 'ok' : 'warn'}`}>
              {STATE_LABEL[state.snapshot.state] ?? state.snapshot.state}
            </span>
          </dd>

          <dt>Monto recibido</dt>
          <dd>{state.snapshot.amountReceivedCents !== null ? mxn(state.snapshot.amountReceivedCents) : '—'}</dd>

          <dt>Pagado</dt>
          <dd>{state.snapshot.paidAt ? dateTime(new Date(state.snapshot.paidAt)) : '—'}</dd>

          {state.snapshot.reference && (
            <>
              <dt>ID de pago</dt>
              <dd className="mono">{state.snapshot.reference}</dd>
            </>
          )}

          {state.snapshot.voucherUrl && (
            <>
              <dt>Ficha / comprobante</dt>
              <dd>
                <a href={state.snapshot.voucherUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                  Abrir ↗
                </a>
              </dd>
            </>
          )}
        </dl>
      )}

      <form action={action}>
        <input type="hidden" name="orderNumber" value={orderNumber} />
        <input type="hidden" name="gatewayName" value={gatewayName} />
        <input type="hidden" name="gatewayChargeId" value={gatewayChargeId ?? ''} />
        <button className="btn" type="submit" disabled={pending}>
          {pending ? 'Consultando…' : 'Verificar pago'}
        </button>
      </form>
    </div>
  );
}

interface ReferenceProps {
  /** This order's own number — used only to flag a mismatch, never sent to Mercado Pago. */
  currentOrderNumber: string;
}

/**
 * The reverse lookup: the customer quotes a payment reference, and this says
 * which order Mercado Pago actually has it tied to. Not gated to a
 * Mercado-Pago-gateway order like `CheckMercadoPagoButton` above — the
 * disputed order being viewed might be a manual-transfer or Stripe order
 * while the reference the customer is waving around is a real Mercado Pago
 * receipt from a *different* order entirely, which is exactly the dispute
 * this exists to settle. `checkMercadoPagoReference` itself reports plainly
 * when Mercado Pago isn't configured on this server at all.
 */
export function CheckMercadoPagoReferenceForm({ currentOrderNumber }: ReferenceProps) {
  const [state, action, pending] = useActionState<MpReferenceCheckState, FormData>(checkMercadoPagoReference, {
    status: 'idle',
  });

  const mismatched =
    state.status === 'ok' && state.snapshot && state.snapshot.orderNumber !== currentOrderNumber;

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Verificar una referencia de pago</h2>
      <p className="subtitle">
        Cuando un cliente manda un número de pago o comprobante que dice que es de este pedido,
        pégalo aquí para ver, directamente desde Mercado Pago, a qué pedido pertenece en realidad.
      </p>

      {state.status === 'error' && <div className="alert bad">{state.message}</div>}
      {state.status === 'not_found' && <div className="alert bad">{state.message}</div>}

      {state.status === 'ok' && state.snapshot && (
        <dl className="kv">
          <dt>Pedido real</dt>
          <dd>
            {state.snapshot.orderNumber ? (
              <span className={`badge ${mismatched ? 'bad' : 'ok'}`}>{state.snapshot.orderNumber}</span>
            ) : (
              <span className="badge warn">Ningún pedido</span>
            )}
            {mismatched && (
              <strong style={{ color: 'var(--bad)', marginLeft: 8 }}>
                ⚠ No es este pedido ({currentOrderNumber})
              </strong>
            )}
          </dd>

          <dt>Estado en Mercado Pago</dt>
          <dd>
            <span className={`badge ${state.snapshot.state === 'paid' ? 'ok' : 'warn'}`}>
              {STATE_LABEL[state.snapshot.state] ?? state.snapshot.state}
            </span>
          </dd>

          <dt>Monto recibido</dt>
          <dd>{state.snapshot.amountReceivedCents !== null ? mxn(state.snapshot.amountReceivedCents) : '—'}</dd>

          <dt>Pagado</dt>
          <dd>{state.snapshot.paidAt ? dateTime(new Date(state.snapshot.paidAt)) : '—'}</dd>

          {state.snapshot.voucherUrl && (
            <>
              <dt>Ficha / comprobante</dt>
              <dd>
                <a href={state.snapshot.voucherUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                  Abrir ↗
                </a>
              </dd>
            </>
          )}
        </dl>
      )}

      <form action={action}>
        <label className="field">
          <span>Referencia de pago</span>
          <input name="paymentId" type="text" placeholder="ej. 183217184493" required autoFocus />
        </label>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? 'Consultando…' : 'Verificar referencia'}
        </button>
      </form>
    </div>
  );
}

interface RelinkProps {
  orderId: string;
  orderNumber: string;
}

/**
 * The write counterpart of `CheckMercadoPagoReferenceForm` above — once
 * that's confirmed a real Mercado Pago charge belongs to THIS order but
 * isn't linked locally (the race `applyGatewayReport`'s own doc comment in
 * apps/web describes), this actually attaches it and, if already paid,
 * approves it. See `relinkMercadoPagoPayment`'s own doc comment for the
 * full story — built 2026-11-26 for Jose's "some SPEI payments don't link
 * to the correct order" report.
 *
 * Deliberately only shown while the order is still genuinely awaiting
 * payment — `relinkMercadoPagoPayment` itself refuses anything else, so
 * offering the form past that point would just invite a confusing "no se
 * puede" every time.
 */
export function RelinkMercadoPagoForm({ orderId, orderNumber }: RelinkProps) {
  const [state, action, pending] = useActionState<RelinkState, FormData>(relinkMercadoPagoPayment, {});
  const [isEmbedded, setIsEmbedded] = useState(true);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Vincular un pago de Mercado Pago a este pedido</h2>
      <p className="subtitle">
        Cuando Mercado Pago ya confirma el pago (usa &quot;Verificar una referencia&quot; arriba para
        comprobarlo) pero este pedido sigue esperando, pégalo aquí para vincularlo y, si ya está
        pagado, confirmarlo de una vez.
      </p>

      {state.error && <div className="alert bad">{state.error}</div>}
      {state.ok && <div className="alert ok">{state.ok}</div>}

      <form action={action}>
        <input type="hidden" name="orderId" value={orderId} />
        <input type="hidden" name="orderNumber" value={orderNumber} />
        <input type="hidden" name="gatewayName" value={isEmbedded ? 'mercadopago-embedded' : 'mercadopago'} />

        <label className="field">
          <span>Tipo de integración</span>
          <select value={isEmbedded ? 'embedded' : 'checkoutpro'} onChange={(e) => setIsEmbedded(e.target.value === 'embedded')}>
            <option value="embedded">Mercado Pago embebido (tarjeta/SPEI actual)</option>
            <option value="checkoutpro">Mercado Pago Checkout Pro</option>
          </select>
        </label>

        <label className="field">
          <span>{isEmbedded ? 'Id del pedido en Mercado Pago' : 'Referencia (id) del pago'}</span>
          <input
            name="reference"
            type="text"
            placeholder={isEmbedded ? 'ej. ORD01M8C3S5VQZ6ZEYTWFWANT4N6G' : 'ej. 183217184493'}
            required
            autoFocus
          />
        </label>

        <button className="btn" type="submit" disabled={pending}>
          {pending ? 'Vinculando…' : 'Vincular y confirmar si ya está pagado'}
        </button>
      </form>
    </div>
  );
}
