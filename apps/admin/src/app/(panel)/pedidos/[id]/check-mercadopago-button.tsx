'use client';

import { useActionState } from 'react';
import { checkMercadoPagoPayment, type MpCheckState } from './actions';
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
