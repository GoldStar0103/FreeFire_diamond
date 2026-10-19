'use client';

import { useActionState } from 'react';
import { checkMercadoPagoPayment, checkMercadoPagoReference, type MpCheckState, type MpReferenceCheckState } from './actions';
import { dateTime, mxn } from '../../../../lib/format';

interface Props {
  orderNumber: string;
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
export function CheckMercadoPagoButton({ orderNumber }: Props) {
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
