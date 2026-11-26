'use client';

import { useActionState, useState, type FormEvent } from 'react';
import { reactivateExpiredPayment, type ReactivateExpiredState } from './actions';

interface Props {
  orderId: string;
  orderNumber: string;
}

const confirmFirst = (message: string) => (event: FormEvent<HTMLFormElement>) => {
  if (!window.confirm(message)) event.preventDefault();
};

/**
 * Only rendered for an order whose payment window already closed — see the
 * order-detail page's own condition. Built 2026-11-26 for exactly the case
 * `releasePayment`'s own doc comment flags as out of its scope: a real
 * gateway payment that genuinely arrived, but after this app's own deadline
 * already passed. Re-verifies the reference directly with the named gateway
 * before touching anything — see `reactivateExpiredPayment`'s own comment.
 */
export function ReactivateExpiredForm({ orderId, orderNumber }: Props) {
  const [state, action, pending] = useActionState<ReactivateExpiredState, FormData>(reactivateExpiredPayment, {});
  const [gatewayName, setGatewayName] = useState<'stripe' | 'mercadopago' | 'mercadopago-embedded'>('stripe');

  return (
    <div className="card" style={{ borderColor: 'var(--bad)' }}>
      <h2 style={{ marginTop: 0 }}>Reactivar pedido vencido</h2>
      <p className="subtitle">
        Solo para cuando la pasarela confirma que el pago sí llegó (verifícalo primero) pero el
        pedido ya venció aquí antes de que esa confirmación llegara — típicamente un pago que
        tardó más de lo normal en resolverse. Esto reactiva el pedido y libera la recarga de
        inmediato. Nunca se confía en que el pago llegó solo porque lo pides: esto vuelve a
        preguntarle directamente a la pasarela antes de hacer cualquier cosa.
      </p>

      {state.error && <div className="alert bad">{state.error}</div>}
      {state.ok && <div className="alert ok">{state.ok}</div>}

      <form
        action={action}
        onSubmit={confirmFirst(
          `¿Confirmaste con la pasarela que ${orderNumber} sí fue pagado? Esto va a reactivar el pedido y liberar la recarga ahora mismo.`,
        )}
      >
        <input type="hidden" name="orderId" value={orderId} />
        <input type="hidden" name="orderNumber" value={orderNumber} />

        <label className="field">
          <span>Pasarela</span>
          <select
            name="gatewayName"
            value={gatewayName}
            onChange={(e) => setGatewayName(e.target.value as typeof gatewayName)}
          >
            <option value="stripe">Stripe</option>
            <option value="mercadopago-embedded">Mercado Pago embebido (tarjeta/SPEI actual)</option>
            <option value="mercadopago">Mercado Pago Checkout Pro</option>
          </select>
        </label>

        <label className="field">
          <span>{gatewayName === 'stripe' ? 'Id del PaymentIntent (pi_…)' : gatewayName === 'mercadopago-embedded' ? 'Id del pedido en Mercado Pago' : 'Referencia (id) del pago'}</span>
          <input
            name="reference"
            type="text"
            placeholder={gatewayName === 'stripe' ? 'ej. pi_3Ug9X57nhvCklWNr0NZoQTcd' : 'ej. 191806323746'}
            required
          />
        </label>

        <button className="btn danger wide" type="submit" disabled={pending}>
          {pending ? 'Reactivando…' : '⚠️ Reactivar y liberar'}
        </button>
      </form>
    </div>
  );
}
